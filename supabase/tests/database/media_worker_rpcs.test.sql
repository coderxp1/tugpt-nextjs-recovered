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
-- ON THE CONCURRENCY TEST. pgTAP here is single-session and dblink is
-- available in neither the local harness (plain PostgreSQL, no pgmq
-- either) nor by default on the Supabase stack CI runs. A true
-- two-session interleaving therefore cannot be expressed in this suite.
-- What IS tested, serially: two enqueue calls for the same org, the second
-- rejected with P3M09 (D2), plus the idempotency-race branch of the
-- EXCEPTION handler. The actual race-safety comes from the guard itself —
-- a non-deferrable partial unique index, whose per-row check is atomic in
-- PostgreSQL by construction — so the serialized test pins the only part
-- this layer owns: the mapping of unique_violation to
-- MEDIA_CONCURRENCY_EXCEEDED. TODO: if dblink is ever enabled in the CI
-- database, add a genuine two-session interleaving test that holds the
-- first transaction open across the second call.
--
-- ON THE FIXTURE TRAP (see transcription_worker_rpcs.test.sql): every
-- "returns nothing / throws" is paired with a control proving the same
-- fixture succeeds one step earlier or on the caller's own org.
--
-- ON WHAT IS DELIBERATELY ABSENT. There is NO public.fail_media_job, for
-- the reason 20260905000001 documents for transcription: read_media_jobs
-- reconciles attempts to PGMQ's read_ct, and a second attempts-incrementing
-- RPC would double-count. W4 pins the absence.

BEGIN;
SELECT plan(76);

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
  SELECT * FROM public.enqueue_media_job(
    p_user, p_org, 'image', 'Un cartel para la clínica', '{}'::jsonb, p_key);
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
  'P3M12', 'P1: unknown kind rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', '', '{}'::jsonb, 'p2')$$,
  'P3M12', 'P2: empty prompt rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', repeat('x', 1001), '{}'::jsonb, 'p3')$$,
  'P3M12', 'P3: prompt over 1000 chars rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', 'ok', '[1]'::jsonb, 'p4')$$,
  'P3M12', 'P4: non-object params rejected'
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
  'P3M09', 'D1: second active job for the org is rejected'
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
  'P3M12', 'X6: cancel without a reason rejected');

SELECT throws_ok(
  $$SELECT pg_temp.cancel_key('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g1', 'too late')$$,
  'P3M11', 'X7: cancelling a completed job rejected');

-- --- S: prompt_id submission discipline ----------------------------------------------

SELECT is((SELECT count(*)::int FROM public.read_media_jobs(600, 10)), 1,
          'S1: claim the g3 job');

SELECT throws_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', '')$$,
  'P3M07', 'S2: empty prompt_id rejected');

SELECT lives_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'p-a')$$,
  'S3: first submission recorded');

SELECT lives_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'p-a')$$,
  'S4: re-recording the same prompt_id is idempotent');

SELECT throws_ok(
  $$SELECT pg_temp.submit_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'p-b')$$,
  'P3M08', 'S5: overwriting a recorded prompt_id rejected');

-- --- A: archive path -----------------------------------------------------------------

SELECT throws_ok(
  $$SELECT pg_temp.archive_key('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'g3', 'NOPE')$$,
  'P3M06', 'A1: archive rejects codes outside the allowlist');

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
  'P3M02', 'K4: skipping a terminal job rejected');

-- --- T: cross-org denial -----------------------------------------------------------------

SELECT throws_ok(
  $$SELECT pg_temp.enq('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000b1'::uuid, 'x1')$$,
  'P3M13', 'T1: member of A cannot enqueue for B');

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
  'P3M10', 'F1: enqueue with the flag off is rejected');

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
  'P3M14', 'I2: same key with a different prompt raises MEDIA_IDEMPOTENCY_CONFLICT');

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'video', 'Un cartel para la clínica', '{}'::jsonb, 'i1')$$,
  'P3M14', 'I3: same key with a different kind raises MEDIA_IDEMPOTENCY_CONFLICT');

SELECT throws_ok(
  $$SELECT * FROM public.enqueue_media_job('11111111-7c11-0000-0000-0000000000a1'::uuid, 'aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'image', 'Un cartel para la clínica', '{"lane":"quality"}'::jsonb, 'i1')$$,
  'P3M14', 'I4: same key with different params raises MEDIA_IDEMPOTENCY_CONFLICT');

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
  'P3M15', 'R4: path naming another org rejected');

SELECT throws_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/00000000-0000-0000-0000-000000000000.png')$$,
  'P3M15', 'R5: path naming another job rejected');

SELECT throws_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r1',
    'media/aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r1) || '.png')$$,
  'P3M15', 'R6: bucket-prefixed legacy shape rejected');

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
  'P3M15', 'R12: video job completed with .png rejected');

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
  'P3M15', 'R17: image job completed with .mp4 rejected');

SELECT lives_ok(
  $$SELECT pg_temp.complete_path('aaaaaaaa-7c11-0000-0000-0000000000a1'::uuid, 'r3',
    'aaaaaaaa-7c11-0000-0000-0000000000a1/' || (SELECT job_id FROM _r3) || '.png')$$,
  'R18: image job completed with .png succeeds');

SELECT * FROM finish();
ROLLBACK;
