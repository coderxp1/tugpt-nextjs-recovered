-- media_worker_rpcs.test.sql
--
-- Phase A item 1 (migration 20260927000001): the media enqueue path, the
-- worker claim cycle, submission/completion/cancellation, and the archive
-- path — with the tenancy and concurrency rules pinned.
--
-- WHAT THIS FILE IS DEFENDING, in descending order of cost:
--
--   1. A second GPU render for one request. Two mechanisms exist and each is
--      tested: the idempotency key (C-group, resubmit returns the same job)
--      and the one-active-job-per-org guard (D-group, second active job is
--      rejected with MEDIA_CONCURRENCY_EXCEEDED, and the guard releases when
--      the first job terminates).
--
--   2. Cross-organisation writes. The enqueue and cancel RPCs re-validate
--      the caller's membership; a caller cannot name an org it does not
--      belong to (T-group). Every negative is paired with a positive
--      control on the caller's own org.
--
--   3. Spending GPU minutes while the flag is off (F-group), and the
--      prompt_id handle discipline: never overwritten once set (S-group),
--      because overwriting orphans a running render.
--
--   4. A wrong render handed back for a job, and a key reused for a
--      different request. complete_media_job accepts only the job's own
--      object key <org_id>/<job_id>.<ext> (R-group, P3M15); an idempotency
--      key resubmitted with a different prompt/kind/params raises
--      MEDIA_IDEMPOTENCY_CONFLICT instead of silently returning the old
--      job (I-group); key normalisation is pinned so ' k' and 'k' are the
--      same key (N-group).
--
-- ON THE CONCURRENCY TESTS. D1 is the serialized pin: two enqueue calls
-- for the same org, the second rejected with P3M09 — it pins the mapping
-- of unique_violation to MEDIA_CONCURRENCY_EXCEEDED, the only part of the
-- guard this layer owns. D3 is the genuine article: two dblink sessions
-- hold uncommitted enqueues on the same org at the same time, and the
-- non-deferrable partial unique index admits exactly one winner. D3 needs
-- a dblink self-connection over the unix socket (CREATE EXTENSION runs
-- just below, as the postgres superuser, outside the test transaction).
-- Where the environment cannot provide the self-connection, D3a..D3d SKIP
-- with a diagnostic instead of failing — a skipped race test is reported,
-- never silent.
--
-- ON THE FIXTURE TRAP (see transcription_worker_rpcs.test.sql): every
-- "returns nothing / throws" is paired with a control proving the same
-- fixture succeeds one step earlier or on the caller's own org.
--
-- ON WHAT IS DELIBERATELY ABSENT. There is NO public.fail_media_job, for
-- the reason 20260905000001 documents for transcription: read_media_jobs
-- reconciles attempts to PGMQ's read_ct, and a second attempts-incrementing
-- RPC would double-count. W4 pins the absence.

-- dblink powers the genuine two-session race test (D3). It must be created
-- outside the test transaction below, as the superuser the suite runs as.
CREATE EXTENSION IF NOT EXISTS dblink;

BEGIN;
SELECT plan(82);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-7c11-0000-0000-0000000000a1', 'Clínica Media A', 'media-test-org-a'),
  ('aaaaaaaa-7c11-0000-0000-0000000000b1', 'Clínica Media B', 'media-test-org-b'),
  ('aaaaaaaa-7c11-0000-0000-0000000000c1', 'Clínica Media C', 'media-test-org-c');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
  ('00000000-0000-0000-0000-000000000000','11111111-7c11-0000-0000-0000000000a1','authenticated','authenticated','media-a@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','11111111-7c11-0000-0000-0000000000b1','authenticated','authenticated','media-b@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','11111111-7c11-0000-0000-0000000000c1','authenticated','authenticated','media-c@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','','')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email) VALUES
  ('11111111-7c11-0000-0000-0000000000a1', 'media-a@example.com'),
  ('11111111-7c11-0000-0000-0000000000b1', 'media-b@example.com'),
  ('11111111-7c11-0000-0000-0000000000c1', 'media-c@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-7c11-0000-0000-0000000000a1', '11111111-7c11-0000-0000-0000000000a1', 'owner'),
  ('aaaaaaaa-7c11-0000-0000-0000000000b1', '11111111-7c11-0000-0000-0000000000b1', 'owner'),
  ('aaaaaaaa-7c11-0000-0000-0000000000c1', '11111111-7c11-0000-0000-0000000000c1', 'owner');

-- Global flag on; orgs A and B on; org C missing (missing = disabled).
INSERT INTO public.feature_flags (organization_id, key, is_enabled)
SELECT NULL, 'media_generation', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE organization_id IS NULL AND key = 'media_generation'
);
UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id IS NULL AND key = 'media_generation';

INSERT INTO public.feature_flags (organization_id, key, is_enabled) VALUES
  ('aaaaaaaa-7c11-0000-0000-0000000000a1', 'media_generation', true),
  ('aaaaaaaa-7c11-0000-0000-0000000000b1', 'media_generation', true);

-- --- Helpers ---------------------------------------------------------------

-- Enqueue through the production RPC. Fixed kind/prompt; the key varies.
CREATE OR REPLACE FUNCTION pg_temp.enq(p_user UUID, p_org UUID, p_key TEXT)
RETURNS TABLE(job_id UUID, already_exists BOOLEAN, pgmq_msg_id BIGINT)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT r.job_id, r.already_exists, r.pgmq_msg_id
  FROM public.enqueue_media_job(
    p_user, p_org, 'image', 'Un cartel para la clínica', '{}'::jsonb, p_key) AS r;
END;
$$;

-- Complete helper: builds the only acceptable result_path — the job's own
-- object key <org_id>/<job_id>.png — so tests exercise the tenant check
-- rather than bypassing it.
CREATE OR REPLACE FUNCTION pg_temp.submit_complete(
  p_org UUID, p_key TEXT, p_prompt_id TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_path TEXT;
BEGIN
  SELECT id INTO v_id FROM public.media_generation_jobs
  WHERE organization_id = p_org AND idempotency_key = p_key;
  v_path := p_org::text || '/' || v_id::text || '.png';
  PERFORM public.record_media_submission(v_id, p_prompt_id);
  PERFORM public.complete_media_job(v_id, v_path, 95.5);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.cancel_key(
  p_user UUID, p_org UUID, p_key TEXT, p_reason TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM public.media_generation_jobs
  WHERE organization_id = p_org AND idempotency_key = p_key;
  RETURN public.cancel_media_job(p_user, v_id, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.submit_key(
  p_org UUID, p_key TEXT, p_prompt_id TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM public.media_generation_jobs
  WHERE organization_id = p_org AND idempotency_key = p_key;
  PERFORM public.record_media_submission(v_id, p_prompt_id);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.archive_key(
  p_org UUID, p_key TEXT, p_code TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_msg BIGINT; v_out RECORD;
BEGIN
  SELECT id, pgmq_msg_id INTO v_id, v_msg FROM public.media_generation_jobs
  WHERE organization_id = p_org AND idempotency_key = p_key;
  SELECT * INTO v_out
  FROM public.archive_media_failed_job(v_msg, v_id, p_code, 'detail from test');
  RETURN v_out.archived;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.skip_key(
  p_org UUID, p_key TEXT, p_reason TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_msg BIGINT;
BEGIN
  SELECT id, pgmq_msg_id INTO v_id, v_msg FROM public.media_generation_jobs
  WHERE organization_id = p_org AND idempotency_key = p_key;
  RETURN public.skip_media_job(v_id, v_msg, p_reason);
END;
$$;

-- Attempt completion with an explicitly chosen path (for the R-group).
CREATE OR REPLACE FUNCTION pg_temp.complete_path(
  p_org UUID, p_key TEXT, p_path TEXT
)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM public.media_generation_jobs
  WHERE organization_id = p_org AND idempotency_key = p_key;
  RETURN public.complete_media_job(v_id, p_path);
END;
$$;

-- --- P: params validation ----------------------------------------------------

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'audio', 'x', '{}'::jsonb, 'p1')$$,
  'P3M12', 'INVALID_MEDIA_PARAMS', 'P1: unknown kind rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', '', '{}'::jsonb, 'p2')$$,
  'P3M12', 'INVALID_MEDIA_PARAMS', 'P2: empty prompt rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', repeat('x', 1001), '{}'::jsonb, 'p3')$$,
  'P3M12', 'INVALID_MEDIA_PARAMS', 'P3: prompt over 1000 chars rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', 'ok', '[1]'::jsonb, 'p4')$$,
  'P3M12', 'INVALID_MEDIA_PARAMS', 'P4: non-object params rejected'
);

-- --- E: first enqueue ----------------------------------------------------------

CREATE TEMP TABLE _e1 ON COMMIT DROP AS
SELECT * FROM pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid,
                          'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g1');

SELECT ok((SELECT count(*)::int FROM _e1) = 1, 'E1: first enqueue returns one row');
SELECT is((SELECT already_exists FROM _e1), false, 'E2: first enqueue is not a resubmit');
SELECT is((SELECT status FROM public.media_generation_jobs WHERE id = (SELECT job_id FROM _e1)),
          'queued', 'E3: job row starts queued');

-- --- C: idempotent resubmit ----------------------------------------------------

CREATE TEMP TABLE _e2 ON COMMIT DROP AS
SELECT * FROM pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid,
                          'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g1');

SELECT is((SELECT already_exists FROM _e2), true, 'C1: same key resubmits as already_exists');
SELECT is((SELECT job_id FROM _e2), (SELECT job_id FROM _e1),
          'C2: resubmit returns the same job, no second render');

-- --- D: one active job per org ---------------------------------------------------

-- Serialized approximation of the two-concurrent-callers case (see header TODO).
SELECT throws_ok(
  $$SELECT * FROM pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g2')$$,
  'P3M09', 'MEDIA_CONCURRENCY_EXCEEDED', 'D1: second active job for the org is rejected'
);

-- --- E (cont.): claim -> submit -> complete ----------------------------------------

SELECT is((SELECT count(*)::int FROM public.read_media_jobs(600, 10)), 1,
          'E4: claim returns the single queued job');

SELECT lives_ok(
  $$SELECT pg_temp.submit_complete('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g1', 'prompt-1')$$,
  'E5: record submission then complete succeeds');

SELECT is((SELECT status FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g1'),
          'completed', 'E6: job is completed');
SELECT is((SELECT result_path FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g1'),
          'aaaaaaaa-7c11-0000-0000-0000000000a1/' ||
            (SELECT id::text FROM public.media_generation_jobs
             WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid
             AND idempotency_key = 'g1') || '.png',
          'E7: result path is the job''s own object key');
SELECT is((SELECT gpu_seconds FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g1'),
          95.5::numeric, 'E8: gpu_seconds recorded');
SELECT ok((SELECT finished_at FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g1')
          IS NOT NULL, 'E9: finished_at set on completion');
SELECT is((SELECT created_by FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g1'),
          '11111111-7c11-0000-0000-0000000000a1'::uuid, 'E10: created_by names the submitting user');

-- Guard releases when the job terminates: a new key enqueues fine.
SELECT lives_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g2')$$,
  'D2: enqueue succeeds after the previous job completed');

-- --- D3: genuine two-session race -------------------------------------------------
--
-- D1 pins the serialized mapping; D3 pins the property the mapping exists
-- for. Two dblink sessions hold uncommitted enqueues on the same org at
-- the same time; the non-deferrable partial unique index admits exactly
-- one winner.
--
-- Orchestration:
--   1. setup session: org D (+ owner, flag on), COMMIT — visible to all.
--   2. session A: BEGIN; enqueue(org D, key 'race-a') -> job_a, msg_a.
--      A holds its transaction OPEN (uncommitted).
--   3. session B: BEGIN; enqueue(org D, key 'race-b') sent ASYNC. B's INSERT
--      blocks on the unique index behind A's uncommitted row. (Async: a
--      synchronous call would deadlock the orchestrating session.)
--   4. session A: COMMIT. B's INSERT is released, meets the now-committed
--      duplicate, raises unique_violation, which the RPC maps to P3M09.
--   5. record: B's SQLSTATE, active-job count for org D, the survivor's id.
--   6. cleanup: A's queue message, job row, and org D fixtures, so the
--      groups below see exactly the state the serialized tests left.
--
-- Determinism: B's query is issued only after A's enqueue has returned, so
-- every interleaving ends with B losing on the index — B's INSERT either
-- blocks-then-fails (before A's COMMIT) or fails at once (after). The
-- pg_sleep only widens the overlap window; it does not decide the outcome.

-- Self-connection for the genuine two-session race. Tries the unix socket
-- first, then TCP loopback on the server's own port: under
-- `supabase test db` (CI and local) the test session arrives over TCP and
-- the unix-socket self-connection is unavailable, so the probe falls through
-- to TCP. The last resort uses the documented Supabase local default
-- credentials (postgres/postgres). Returns NULL when nothing works; the diag
-- below then prints the actual libpq error instead of silently skipping.
CREATE OR REPLACE FUNCTION pg_temp.race_connstr() RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT unnest(ARRAY[
      format('dbname=%s', current_database()),
      format('host=/var/run/postgresql dbname=%s', current_database()),
      format('host=localhost port=%s dbname=%s',
             current_setting('port'), current_database()),
      format('host=localhost port=%s dbname=%s user=postgres password=postgres',
             current_setting('port'), current_database())
    ])
  LOOP
    BEGIN
      PERFORM dblink_connect('race_probe', c);
      PERFORM dblink_disconnect('race_probe');
      RETURN c;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- try the next candidate
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TEMP TABLE _race_env(avail BOOLEAN, detail TEXT);
CREATE TEMP TABLE _race_out(
  a_job UUID, a_msg BIGINT, b_sqlstate TEXT, active_ct INT, survivor UUID
);

DO $race$
DECLARE
  v_conn TEXT := pg_temp.race_connstr();
BEGIN
  IF v_conn IS NULL THEN
    BEGIN
      -- Capture the concrete reason the last-resort candidate failed.
      PERFORM dblink_connect('race_probe',
        format('host=localhost port=%s dbname=%s user=postgres password=postgres',
               current_setting('port'), current_database()));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _race_env VALUES (false, SQLERRM);
      RETURN;
    END;
    PERFORM dblink_disconnect('race_probe');
    INSERT INTO _race_env VALUES (false, 'unexpected: last-resort probe connected on retry');
  ELSE
    INSERT INTO _race_env VALUES (true, v_conn);
  END IF;
END $race$;

SELECT diag('D3 genuine race: dblink self-connection ' ||
  CASE WHEN (SELECT avail FROM _race_env) THEN 'available via ' || (SELECT detail FROM _race_env)
       ELSE 'UNAVAILABLE — D3a..D3d will skip (' || (SELECT detail FROM _race_env) || ')' END);

SELECT skip('D3: dblink self-connection unavailable in this environment', 4)
WHERE NOT (SELECT avail FROM _race_env);

DO $race$
DECLARE
  v_conn TEXT := pg_temp.race_connstr();
  v_org  UUID := 'aaaaaaaa-7c11-0000-0000-0000000000d1';
  v_user UUID := '11111111-7c11-0000-0000-0000000000d1';
  v_a_job UUID;
  v_a_msg BIGINT;
  v_b_sqlstate TEXT := 'NO_ERROR';
  v_active INT;
  v_survivor UUID;
BEGIN
  IF NOT (SELECT avail FROM _race_env) THEN RETURN; END IF;

  -- 1. Committed fixtures for org D, via their own session (this session's
  --    own inserts are uncommitted and invisible to the race sessions).
  PERFORM dblink_connect('race_setup', v_conn);
  PERFORM dblink_exec('race_setup', 'BEGIN');
  PERFORM dblink_exec('race_setup', format(
    $$INSERT INTO public.organizations(id,name,slug)
      VALUES ('%s','Race Org D','race-org-d')$$, v_org));
  PERFORM dblink_exec('race_setup', format(
    $$INSERT INTO public.profiles(id,email)
      VALUES ('%s','race-d@example.com')$$, v_user));
  PERFORM dblink_exec('race_setup', format(
    $$INSERT INTO public.organization_members(organization_id,user_id,role)
      VALUES ('%s','%s','owner')$$, v_org, v_user));
  PERFORM dblink_exec('race_setup', format(
    $$INSERT INTO public.feature_flags(organization_id,key,is_enabled)
      VALUES ('%s','media_generation',true)$$, v_org));
  -- The global flag row lives in this session's uncommitted transaction and
  -- is invisible to the race sessions; commit it for them too (idempotent).
  PERFORM dblink_exec('race_setup',
    $$INSERT INTO public.feature_flags(organization_id,key,is_enabled)
      SELECT NULL,'media_generation',true
      WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags
                        WHERE organization_id IS NULL
                          AND key = 'media_generation')$$);
  PERFORM dblink_exec('race_setup', 'COMMIT');
  PERFORM dblink_disconnect('race_setup');

  -- 2. Session A enqueues and HOLDS its transaction open.
  PERFORM dblink_connect('race_a', v_conn);
  PERFORM dblink_exec('race_a', 'BEGIN');
  SELECT j.job_id, j.pgmq_msg_id INTO v_a_job, v_a_msg
  FROM dblink('race_a', format(
    $$SELECT job_id, pgmq_msg_id FROM public.enqueue_media_job('%s','%s','image','Un cartel','{}'::jsonb,'race-a')$$,
    v_user, v_org)) AS j(job_id UUID, pgmq_msg_id BIGINT);

  -- 3. Session B enqueues ASYNC — blocks on the index behind A's row.
  PERFORM dblink_connect('race_b', v_conn);
  PERFORM dblink_exec('race_b', 'BEGIN');
  PERFORM dblink_send_query('race_b', format(
    $$SELECT job_id FROM public.enqueue_media_job('%s','%s','image','Un cartel','{}'::jsonb,'race-b')$$,
    v_user, v_org));
  PERFORM pg_sleep(0.5);

  -- 4. A commits; B's INSERT is released and loses on the index.
  PERFORM dblink_exec('race_a', 'COMMIT');
  BEGIN
    PERFORM dblink_get_result('race_b');
  EXCEPTION WHEN OTHERS THEN
    v_b_sqlstate := SQLSTATE;
  END;
  -- B's session still holds the failed async query: a plain ROLLBACK on it
  -- raises "another command is already in progress". Disconnecting aborts
  -- the remote transaction and releases the speculative insert instead.
  PERFORM dblink_disconnect('race_b');
  PERFORM dblink_disconnect('race_a');

  -- 5. Record the race outcome (A's row is committed; B's rolled back).
  SELECT count(*)::int INTO v_active
  FROM public.media_generation_jobs
  WHERE organization_id = v_org AND status IN ('queued','processing');
  SELECT id INTO v_survivor
  FROM public.media_generation_jobs
  WHERE organization_id = v_org AND status IN ('queued','processing')
  LIMIT 1;
  INSERT INTO _race_out VALUES (v_a_job, v_a_msg, v_b_sqlstate, v_active, v_survivor);

  -- 6. Cleanup so later groups see the pre-race state.
  PERFORM pgmq.delete('media_jobs', v_a_msg);
  DELETE FROM public.media_generation_jobs WHERE organization_id = v_org;
  DELETE FROM public.feature_flags WHERE organization_id = v_org AND key = 'media_generation';
  DELETE FROM public.organization_members WHERE organization_id = v_org;
  DELETE FROM public.profiles WHERE id = v_user;
  DELETE FROM public.organizations WHERE id = v_org;
  -- race_setup committed a second global flag row (its NOT EXISTS could not
  -- see this session's uncommitted one); collapse back to exactly one so the
  -- scalar subquery in is_feature_enabled keeps working.
  DELETE FROM public.feature_flags WHERE organization_id IS NULL AND key = 'media_generation';
  INSERT INTO public.feature_flags(organization_id,key,is_enabled)
  VALUES (NULL,'media_generation',true);
END $race$;

SELECT is((SELECT b_sqlstate FROM _race_out), 'P3M09',
          'D3a: loser of the genuine two-session race gets P3M09')
WHERE (SELECT avail FROM _race_env);

SELECT is((SELECT active_ct FROM _race_out), 1,
          'D3b: exactly one job survives the race')
WHERE (SELECT avail FROM _race_env);

SELECT is((SELECT survivor FROM _race_out), (SELECT a_job FROM _race_out),
          'D3c: the survivor is the session that committed first')
WHERE (SELECT avail FROM _race_env);

SELECT is((SELECT count(*)::int FROM public.media_generation_jobs
           WHERE idempotency_key = 'race-b'), 0,
          'D3d: the loser''s job row never materialized')
WHERE (SELECT avail FROM _race_env);

-- --- X: cancellation ---------------------------------------------------------------

SELECT lives_ok(
  $$SELECT pg_temp.cancel_key('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g2', 'user asked')$$,
  'X1: cancel with a reason succeeds');

SELECT is((SELECT status FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g2'),
          'cancelled', 'X2: job is cancelled');
SELECT is((SELECT cancel_reason FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g2'),
          'user asked', 'X3: cancel reason recorded');
SELECT is((SELECT count(*)::int FROM pgmq.q_media_jobs
           WHERE msg_id = (SELECT pgmq_msg_id FROM public.media_generation_jobs
                           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid
                           AND idempotency_key = 'g2')),
          0, 'X4: queued message removed on cancel');

SELECT lives_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3')$$,
  'X5: enqueue succeeds after cancellation');

SELECT throws_ok(
  $$SELECT pg_temp.cancel_key('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', '')$$,
  'P3M12', 'INVALID_MEDIA_PARAMS', 'X6: cancel without a reason rejected');

SELECT throws_ok(
  $$SELECT pg_temp.cancel_key('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g1', 'too late')$$,
  'P3M11', 'INVALID_MEDIA_JOB_STATE', 'X7: cancelling a completed job rejected');

-- --- S: prompt_id submission discipline ----------------------------------------------

SELECT is((SELECT count(*)::int FROM public.read_media_jobs(600, 10)), 1,
          'S1: claim the g3 job');

SELECT throws_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', '')$$,
  'P3M07', 'INVALID_MEDIA_SUBMISSION', 'S2: empty prompt_id rejected');

SELECT lives_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'p-a')$$,
  'S3: first submission recorded');

SELECT lives_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'p-a')$$,
  'S4: re-recording the same prompt_id is idempotent');

SELECT throws_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'p-b')$$,
  'P3M08', 'MEDIA_SUBMISSION_ALREADY_RECORDED', 'S5: overwriting a recorded prompt_id rejected');

-- --- A: archive path -----------------------------------------------------------------

SELECT throws_ok(
  $$SELECT pg_temp.archive_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'NOPE')$$,
  'P3M06', 'INVALID_MEDIA_FAILURE_CODE', 'A1: archive rejects codes outside the allowlist');

SELECT is(
  (SELECT pg_temp.archive_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'MEDIA_PROVIDER_ERROR')),
  true, 'A2: archive reports archived');

SELECT is((SELECT status FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g3'),
          'dead_lettered', 'A3: job is dead_lettered');

SELECT is((SELECT count(*)::int FROM public.failed_jobs
           WHERE queue_name = 'media_jobs' AND error_code = 'MEDIA_PROVIDER_ERROR'),
          1, 'A4: one failed_jobs row with the terminal code');

SELECT is(
  (SELECT pg_temp.archive_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'MEDIA_PROVIDER_ERROR')),
  false, 'A5: second archive reports already_archived, no duplicate row');

-- --- K: skip path ----------------------------------------------------------------------

SELECT lives_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g4')$$,
  'K1: enqueue g4');

SELECT lives_ok(
  $$SELECT pg_temp.skip_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g4', 'media_generation disabled mid-flight')$$,
  'K2: skip succeeds');

SELECT is((SELECT status FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g4'),
          'skipped', 'K3: job is skipped, not dead_lettered');

SELECT throws_ok(
  $$SELECT pg_temp.skip_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g4', 'again')$$,
  'P3M02', 'MEDIA_JOB_ALREADY_TERMINAL', 'K4: skipping a terminal job rejected');

-- --- T: cross-org denial -----------------------------------------------------------------

SELECT throws_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000b1'::uuid, 'x1')$$,
  'P3M13', 'MEDIA_TENANT_MISMATCH', 'T1: member of A cannot enqueue for B');

SELECT is((SELECT count(*)::int FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000b1'::uuid),
          0, 'T2: no job row created for the foreign org');

-- Positive control: B's own member enqueues for B with the same key string —
-- the guard and the idempotency key are both per-org.
SELECT lives_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000b1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000b1'::uuid, 'g1')$$,
  'T3: member of B enqueues for B');

SELECT is((SELECT id FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000b1'::uuid AND idempotency_key = 'g1')
          <>
          (SELECT id FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'g1'),
          true, 'T4: same key in two orgs is two jobs');

SELECT lives_ok(
  $$SELECT pg_temp.cancel_key('11111111-7c11-0000-0000-0000000000b1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000b1'::uuid, 'g1', 'cleanup')$$,
  'T5: B job cancelled to leave fixtures clean');

-- --- F: feature flag gate ------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000c1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000c1'::uuid, 'c1')$$,
  'P3M10', 'MEDIA_FEATURE_DISABLED', 'F1: enqueue with the flag off is rejected');

-- --- G: grants ---------------------------------------------------------------------------------

SELECT ok(
  has_function_privilege('service_role',
    'public.enqueue_media_job(uuid, uuid, text, text, jsonb, text)', 'EXECUTE'),
  'G1: service_role can execute enqueue_media_job');

SELECT ok(
  NOT has_function_privilege('anon',
    'public.enqueue_media_job(uuid, uuid, text, text, jsonb, text)', 'EXECUTE'),
  'G2: anon cannot execute enqueue_media_job');

-- --- W: deliberate absences ----------------------------------------------------------------------

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fail_media_job'
  ),
  'W1: no public.fail_media_job — terminal failures go through archive, '
  'so attempts are reconciled in exactly one place');

-- --- N: idempotency key normalisation ---------------------------------------------------

SELECT lives_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'n1')$$,
  'N1: enqueue with key n1');

-- The reported bug: the raw key missed the lookup and died on the unique
-- index with P3M09 instead of returning the existing job.
CREATE TEMP TABLE _n1 ON COMMIT DROP AS
SELECT * FROM pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid,
                          'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, ' n1 ');

SELECT is((SELECT already_exists FROM _n1), true,
  'N2: resubmit with a padded key returns already_exists, not P3M09');
SELECT is((SELECT job_id FROM _n1),
  (SELECT id FROM public.media_generation_jobs
   WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'n1'),
  'N3: padded resubmit returns the same job, no second render');

SELECT lives_ok(
  $$SELECT pg_temp.cancel_key('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'n1', 'cleanup')$$,
  'N4: cleanup cancel frees the guard');

-- --- I: idempotency conflict ---------------------------------------------------------------

SELECT lives_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'i1')$$,
  'I1: enqueue with key i1');

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', 'A different prompt', '{}'::jsonb, 'i1')$$,
  'P3M14', 'MEDIA_IDEMPOTENCY_CONFLICT', 'I2: same key with a different prompt raises MEDIA_IDEMPOTENCY_CONFLICT');

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'video', 'Un cartel para la clínica', '{}'::jsonb, 'i1')$$,
  'P3M14', 'MEDIA_IDEMPOTENCY_CONFLICT', 'I3: same key with a different kind raises MEDIA_IDEMPOTENCY_CONFLICT');

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', 'Un cartel para la clínica', '{"lane":"quality"}'::jsonb, 'i1')$$,
  'P3M14', 'MEDIA_IDEMPOTENCY_CONFLICT', 'I4: same key with different params raises MEDIA_IDEMPOTENCY_CONFLICT');

-- Positive control: an identical resubmit still returns the existing job.
CREATE TEMP TABLE _i1 ON COMMIT DROP AS
SELECT * FROM pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid,
                          'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'i1');

SELECT is((SELECT already_exists FROM _i1), true,
  'I5: identical resubmit returns already_exists, not a conflict');

SELECT lives_ok(
  $$SELECT pg_temp.cancel_key('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'i1', 'cleanup')$$,
  'I6: cleanup cancel frees the guard');

-- --- R: result path tenant check --------------------------------------------------------------

SELECT lives_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1')$$,
  'R1: enqueue r1');

SELECT is((SELECT count(*)::int FROM public.read_media_jobs(600, 10)), 1,
  'R2: claim the r1 job');

SELECT lives_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1', 'prompt-r')$$,
  'R3: record the submission');

CREATE TEMP TABLE _r1 ON COMMIT DROP AS
SELECT id::text AS job_id FROM public.media_generation_jobs
WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'r1';

SELECT throws_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1',
    'aaaaaaaa-7c11-0000-0000-0000000000b1/' || (SELECT job_id FROM _r1) || '.png')$$,
  'P3M15', 'MEDIA_RESULT_PATH_MISMATCH', 'R4: path naming another org rejected');

SELECT throws_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/00000000-0000-0000-0000-000000000000.png')$$,
  'P3M15', 'MEDIA_RESULT_PATH_MISMATCH', 'R5: path naming another job rejected');

SELECT throws_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1',
    'media/aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r1) || '.png')$$,
  'P3M15', 'MEDIA_RESULT_PATH_MISMATCH', 'R6: bucket-prefixed legacy shape rejected');

SELECT lives_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r1) || '.png')$$,
  'R7: the job''s own object key completes');

SELECT is((SELECT result_path FROM public.media_generation_jobs
           WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'r1'),
          'aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r1) || '.png',
          'R8: recorded path is exactly the object key');

-- --- R (cont.): extension must match the job kind --------------------------------------------

SELECT lives_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'video', 'Un video para la clínica', '{}'::jsonb, 'r2')$$,
  'R9: enqueue video job r2');

SELECT is((SELECT count(*)::int FROM public.read_media_jobs(600, 10)), 1,
  'R10: claim the r2 job');

SELECT lives_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r2', 'prompt-r2')$$,
  'R11: record the submission');

CREATE TEMP TABLE _r2 ON COMMIT DROP AS
SELECT id::text AS job_id FROM public.media_generation_jobs
WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'r2';

SELECT throws_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r2',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r2) || '.png')$$,
  'P3M15', 'MEDIA_RESULT_PATH_MISMATCH', 'R12: video job completed with .png rejected');

SELECT lives_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r2',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r2) || '.mp4')$$,
  'R13: video job completed with .mp4 succeeds');

SELECT lives_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', 'Un cartel para la clínica', '{}'::jsonb, 'r3')$$,
  'R14: enqueue image job r3');

SELECT is((SELECT count(*)::int FROM public.read_media_jobs(600, 10)), 1,
  'R15: claim the r3 job');

SELECT lives_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r3', 'prompt-r3')$$,
  'R16: record the submission');

CREATE TEMP TABLE _r3 ON COMMIT DROP AS
SELECT id::text AS job_id FROM public.media_generation_jobs
WHERE organization_id = 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid AND idempotency_key = 'r3';

SELECT throws_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r3',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r3) || '.mp4')$$,
  'P3M15', 'MEDIA_RESULT_PATH_MISMATCH', 'R17: image job completed with .mp4 rejected');

SELECT lives_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r3',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r3) || '.png')$$,
  'R18: image job completed with .png succeeds');

-- --- B: storage bucket is explicitly private ---------------------------------------
--
-- The migration sets public = false explicitly rather than relying on the
-- column default. Where the storage build has no public column (the CI
-- db-start image) there is nothing to assert; where it does, privacy is
-- proved, not assumed.

SELECT ok(
  EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'media'),
  'B1: storage bucket media exists');

SELECT lives_ok(
  $bkt$
  DO $bkt_inner$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'storage'
        AND table_name = 'buckets'
        AND column_name = 'public'
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM storage.buckets WHERE id = 'media' AND public IS FALSE
      ) THEN
        RAISE EXCEPTION 'media bucket is not explicitly private';
      END IF;
    END IF;
  END
  $bkt_inner$;
  $bkt$,
  'B2: media bucket is explicitly private (public = false) where the column exists');

SELECT * FROM finish();
ROLLBACK;
