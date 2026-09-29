-- media_concurrency_race.test.sql — D3: genuine two-session concurrency race.
--
-- D1 (in media_worker_rpcs.test.sql) pins the serialized mapping of
-- unique_violation to MEDIA_CONCURRENCY_EXCEEDED. D3 pins the property the
-- mapping exists for: two sessions holding uncommitted enqueues on the same
-- org at the same time, where the non-deferrable partial unique index
-- admits exactly one winner.
--
-- WHY THIS FILE EXISTS SEPARATELY. The race needs two genuine database
-- sessions, which pgTAP gets via a dblink self-connection. PostgreSQL
-- forbids a non-superuser from opening a dblink connection unless the
-- server actually performed password authentication
-- (dblink_security_check: "password is required"), and the Supabase local
-- stack answers `supabase test db` over trusted TCP — so under the regular
-- `supabase test db --local` run (session user `postgres`, not a
-- superuser there) the self-connection is impossible and any in-file race
-- could only SKIP. A skipped race is not evidence.
--
-- This file therefore runs in the CI `database-tests` job's dedicated race
-- step, invoked as the image's superuser:
--
--   supabase test db \
--     --db-url "postgresql://supabase_admin:postgres@127.0.0.1:56322/postgres" \
--     supabase/tests/database/media_concurrency_race.test.sql
--
-- (port 56322 is config.toml [db].port; supabase_admin is the
-- supabase/postgres superuser whose password the image sets from the db
-- password.) As superuser the dblink security checks are skipped and the
-- unix-socket self-connection just works, so D3a..D3d execute as ordinary
-- assertions. If the self-connection fails here anyway, the file FAILS
-- CLOSED (RAISE EXCEPTION) — there is no skip path in this file.
--
-- Under the regular `--local` run this file is still picked up by the
-- recursive scan, so it detects the non-superuser session and emits
-- plan(0) plus a diagnostic: a standard TAP "no tests here", never a
-- failure, never a skip of a test that claims to have run. (pgTAP's
-- finish() raises "No tests run!" on plan(0), so the no-op path skips
-- finish().)
--
-- Orchestration (superuser path):
--   1. setup session: org D (+ owner, flag on), COMMIT — visible to all.
--   2. session A: BEGIN; enqueue(org D, key 'race-a') -> job_a, msg_a.
--      A holds its transaction OPEN (uncommitted).
--   3. session B: BEGIN; enqueue(org D, key 'race-b') sent ASYNC. B's INSERT
--      blocks on the unique index behind A's uncommitted row. (Async: a
--      synchronous call would deadlock the orchestrating session.)
--   4. session A: COMMIT. B's INSERT is released, meets the now-committed
--      duplicate, raises unique_violation, which the RPC maps to P3M09.
--   5. record: B's SQLSTATE, active-job count for org D, the survivor's id.
--   6. cleanup: A's queue message, job row, and org D fixtures, so no other
--      suite sees this file's state.
--
-- Determinism: B's query is issued only after A's enqueue has returned, so
-- every interleaving ends with B losing on the index — B's INSERT either
-- blocks-then-fails (before A's COMMIT) or fails at once (after). The
-- pg_sleep only widens the overlap window; it does not decide the outcome.

CREATE EXTENSION IF NOT EXISTS dblink;

BEGIN;

CREATE TEMP TABLE _race_run(run BOOLEAN);
INSERT INTO _race_run SELECT rolsuper FROM pg_roles WHERE rolname = current_user;

-- plan(0) is the standard TAP skip-all ("1..0"): pg_prove reports the file
-- as having no tests, and the run stays green. finish() is only for the
-- path that ran tests (it raises "No tests run!" on plan(0)).
DO $plan$
BEGIN
  IF (SELECT run FROM _race_run) THEN
    PERFORM plan(4);
  ELSE
    PERFORM plan(0);
  END IF;
END $plan$;

SELECT diag('D3 genuine race: ' ||
  CASE WHEN (SELECT run FROM _race_run)
       THEN 'running as superuser ' || current_user || ' — D3a..D3d execute for real'
       ELSE 'non-superuser session — no-op under this invocation (runs in the CI race step)' END);

CREATE TEMP TABLE _race_out(
  a_job UUID, a_msg BIGINT, b_sqlstate TEXT, active_ct INT, survivor UUID
);

DO $race$
DECLARE
  v_conn TEXT := format('dbname=%s', current_database());
  v_org  UUID := 'aaaaaaaa-7c11-0000-0000-0000000000d1';
  v_user UUID := '11111111-7c11-0000-0000-0000000000d1';
  v_a_job UUID;
  v_a_msg BIGINT;
  v_b_sqlstate TEXT := 'NO_ERROR';
  v_active INT;
  v_survivor UUID;
BEGIN
  IF NOT (SELECT run FROM _race_run) THEN RETURN; END IF;

  -- Fail closed: as superuser the self-connection must work. Any failure
  -- here is a real environment problem, not a reason to skip.
  BEGIN
    PERFORM dblink_connect('race_selftest', v_conn);
    PERFORM dblink_disconnect('race_selftest');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'D3 race: dblink self-connection failed as superuser %: %',
      current_user, SQLERRM;
  END;

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
    $$SELECT job_id FROM public.enqueue_media_job('%s','%s','image','Un video','{}'::jsonb,'race-b')$$,
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

  -- 6. Cleanup so no other suite sees this file's state.
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
WHERE (SELECT run FROM _race_run);

SELECT is((SELECT active_ct FROM _race_out), 1,
          'D3b: exactly one job survives the race')
WHERE (SELECT run FROM _race_run);

SELECT is((SELECT survivor FROM _race_out), (SELECT a_job FROM _race_out),
          'D3c: the survivor is the session that committed first')
WHERE (SELECT run FROM _race_run);

SELECT is((SELECT count(*)::int FROM public.media_generation_jobs
           WHERE idempotency_key = 'race-b'), 0,
          'D3d: the loser''s job row never materialized')
WHERE (SELECT run FROM _race_run);

DO $finish$
BEGIN
  IF (SELECT run FROM _race_run) THEN
    PERFORM finish();
  END IF;
END $finish$;
ROLLBACK;
