-- transcription_worker_rpcs.test.sql
--
-- The five queue verbs the transcription worker runs on (migration
-- 20260905000001): claim, retry, succeed, skip, dead-letter.
--
-- WHAT THIS FILE IS DEFENDING, in descending order of cost:
--
--   1. Paying twice for one voice note. Gladia bills on submission, so every
--      path that could hand the same job to a provider a second time is an
--      invoice. Three of them exist and each is tested against a positive
--      control: the fourth delivery (R8/R9), a redelivered message for a job
--      that already completed (R10), and a lease too short for a legitimate
--      wait (R2 pins the 120s default that exists for exactly that reason).
--
--   2. A delivery count that is not the queue's. `attempts` lives in two
--      places -- the job row and PGMQ's read_ct -- and read_ct is
--      authoritative. R4-R7 pin the reconciliation in both directions,
--      including the refusal to accept a decrease, and A-group asserts the
--      archive records what was measured rather than coercing a legal value.
--
--   3. Codes the RPC will not accept. On 2026-08-19 the draft worker produced
--      eight terminal codes and its archive RPC accepted five; every terminal
--      failure became three phantom retries and the provider's real complaint
--      was recorded nowhere. A4 and A11 make that impossible to reintroduce
--      quietly here: the allowlist is asserted to accept every code the
--      worker can produce, one assertion per code, not as a set.
--
-- ON THE FIXTURE TRAP. Four times in this stack a test has passed while
-- testing nothing, because its fixture stopped satisfying a precondition the
-- assertion could not see. Two defences are used throughout: every "returns
-- nothing" is paired with a control proving the same fixture DOES return
-- something one step earlier, and every assertion expecting a constraint to
-- fire names the row it fires on.
--
-- ON WHAT IS DELIBERATELY ABSENT. W4 asserts there is NO
-- public.fail_transcription_job. That is not an oversight being documented --
-- it is the decision recorded in the migration header (the function's attempts
-- increment predates the claim RPC and would double-count against read_ct), and
-- an absence nobody tests is an absence that returns.

BEGIN;
SELECT plan(83);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-7c11-0000-0000-000000000001', 'Clínica Worker', 'transcription-worker-test');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('bbbbbbbb-7c11-0000-0000-000000000001', 'aaaaaaaa-7c11-0000-0000-000000000001', 'Recepción');

INSERT INTO public.whatsapp_connections (
  id, organization_id, business_profile_id, phone_number,
  provider_phone_number_id, status
) VALUES (
  'cccccccc-7c11-0000-0000-000000000001', 'aaaaaaaa-7c11-0000-0000-000000000001',
  'bbbbbbbb-7c11-0000-0000-000000000001', '+34600000011', 'conn-tw', 'active'
);

UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id IS NULL AND key IN ('voice_transcription', 'ai_draft_generation');

INSERT INTO public.feature_flags (organization_id, key, is_enabled) VALUES
  ('aaaaaaaa-7c11-0000-0000-000000000001', 'voice_transcription', true);

-- Through the production helper: 20260826000001 refuses to enable
-- ai_draft_generation for an organization with no draft quota period.
SELECT public.enable_draft_generation_for_org(
  'aaaaaaaa-7c11-0000-0000-000000000001', 1000);

-- Delivers one audio message and returns its transcription job id. Every job
-- below is created this way -- through ingest and process, not by INSERT -- so
-- the fixtures are the rows production actually produces, including the
-- pgmq_msg_id that process_inbound_message binds at enqueue time.
CREATE FUNCTION pg_temp.deliver_audio(p_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id UUID;
  v_message_id UUID;
  v_job_id UUID;
BEGIN
  SELECT webhook_event_id INTO v_event_id
  FROM public.ingest_whatsapp_message_event(
    'conn-tw', 'meta', p_key, 'message',
    pg_catalog.encode(pg_catalog.sha256(p_key::bytea), 'hex'),
    p_key, '34600999011', 'audio', NULL,
    '2026-09-05T10:00:00Z'::timestamptz, 'req-' || p_key,
    'media-' || p_key, 'audio/ogg'
  );

  SELECT message_id INTO v_message_id
  FROM public.process_inbound_message(v_event_id);

  SELECT id INTO v_job_id
  FROM public.transcription_jobs
  WHERE source_message_id = v_message_id;

  RETURN v_job_id;
END;
$$;

-- Every claim below must reach the message it is about. `read_transcription_jobs`
-- takes the lowest-numbered visible message, and this file leaves a dozen of
-- them on the queue, so without pinning, a read intended for one job silently
-- claims another and the assertion that follows tests nothing. The first draft
-- of this file did exactly that: three assertions passed against a message they
-- had never touched.
--
-- `now()` is the transaction timestamp and constant here, so parking the others
-- an hour out and pulling this one a second back is exact rather than racy.
CREATE FUNCTION pg_temp.only(p_msg_id BIGINT)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE pgmq.q_transcription
  SET vt = pg_catalog.now() + interval '1 hour'
  WHERE msg_id <> p_msg_id;

  UPDATE pgmq.q_transcription
  SET vt = pg_catalog.now() - interval '1 second'
  WHERE msg_id = p_msg_id;
$$;

-- ===========================================================================
-- F: the fixture itself is what it claims to be
--
-- Everything below reads "a queued transcription job with a bound queue
-- message". If that stopped being true -- a flag default flipped, the enqueue
-- gate tightened -- most of this file would pass while testing an empty set.
-- ===========================================================================

CREATE TEMP TABLE _f_job AS SELECT pg_temp.deliver_audio('wamid.tw001') AS id;

SELECT is(
  (SELECT status FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  'queued',
  'F1: the fixture produced a queued transcription job'
);

SELECT is(
  (SELECT attempts FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  0,
  'F2: a job that no worker has claimed has attempts = 0'
);

SELECT ok(
  (SELECT pgmq_msg_id IS NOT NULL FROM public.transcription_jobs
   WHERE id = (SELECT id FROM _f_job)),
  'F3: process_inbound_message bound the queue message id at enqueue'
);

SELECT is(
  (SELECT count(*)::int FROM pgmq.q_transcription
   WHERE msg_id = (SELECT pgmq_msg_id FROM public.transcription_jobs
                   WHERE id = (SELECT id FROM _f_job))),
  1,
  'F4: the queue message exists and is the one the job points at'
);

-- ===========================================================================
-- R: read_transcription_jobs
-- ===========================================================================

SELECT pg_temp.only((SELECT pgmq_msg_id FROM public.transcription_jobs
                     WHERE id = (SELECT id FROM _f_job)));

CREATE TEMP TABLE _r_claim1 AS
SELECT msg_id, read_ct, payload, vt FROM public.read_transcription_jobs(120, 1) LIMIT 1;

SELECT is(
  (SELECT count(*)::int FROM _r_claim1),
  1,
  'R1: a queued job is returned as work'
);

-- The 120s default is not decoration: an attempt downloads media and then
-- waits on Gladia for up to 300s, and a lease that expires mid-wait hands the
-- same job to a second worker while the first is still legitimately waiting.
SELECT ok(
  (SELECT EXTRACT(EPOCH FROM (vt - pg_catalog.now())) BETWEEN 110 AND 125
   FROM _r_claim1),
  'R2: the lease reflects the requested visibility timeout'
);

-- The DEFAULT matters separately, and a mutation proved it: changing 120 back
-- to 30 survived every assertion in the first draft of this file, because each
-- one passed 120 explicitly. The worker supplies its own value, but every
-- manual call and every misconfiguration gets this one, and a lease shorter
-- than a legitimate Gladia wait is a second submission for one voice note.
CREATE TEMP TABLE _r_dflt_job AS SELECT pg_temp.deliver_audio('wamid.tw001d') AS id;
SELECT pg_temp.only((SELECT pgmq_msg_id FROM public.transcription_jobs
                     WHERE id = (SELECT id FROM _r_dflt_job)));

CREATE TEMP TABLE _r_dflt AS SELECT vt FROM public.read_transcription_jobs() LIMIT 1;

SELECT ok(
  (SELECT EXTRACT(EPOCH FROM (vt - pg_catalog.now())) BETWEEN 110 AND 125 FROM _r_dflt),
  'R2b: called with no arguments, the lease is the 120s the cost argument asks for'
);

SELECT is(
  (SELECT status FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  'processing',
  'R3: a claimed job is marked processing'
);

SELECT is(
  (SELECT read_ct FROM _r_claim1),
  1,
  'R4: the first delivery has read_ct = 1'
);

SELECT is(
  (SELECT attempts FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  1,
  'R5: attempts is reconciled to the authoritative read_ct, not incremented'
);

SELECT is(
  (SELECT (payload->>'transcriptionJobId')::uuid FROM _r_claim1),
  (SELECT id FROM _f_job),
  'R6: the payload carries the job id the worker will look up'
);

-- Second delivery.
SELECT pg_temp.only((SELECT msg_id FROM _r_claim1));

CREATE TEMP TABLE _r_claim2 AS
SELECT msg_id, read_ct FROM public.read_transcription_jobs(120, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _r_claim2),
  2,
  'R7: a redelivery increments read_ct'
);

SELECT is(
  (SELECT attempts FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  2,
  'R8: attempts follows read_ct on redelivery'
);

-- Third delivery: still work. This is the positive control for R10 -- without
-- it, "the fourth delivery returns nothing" could be satisfied by a claim path
-- that returns nothing at all.
SELECT pg_temp.only((SELECT msg_id FROM _r_claim2));

CREATE TEMP TABLE _r_claim3 AS
SELECT msg_id, read_ct FROM public.read_transcription_jobs(120, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _r_claim3),
  3,
  'R9: the third delivery is still returned as work (control for R10)'
);

-- Fourth delivery: the terminal path. No fourth Gladia submission.
SELECT pg_temp.only((SELECT msg_id FROM _r_claim3));

SELECT is(
  (SELECT count(*)::int FROM public.read_transcription_jobs(120, 1)),
  0,
  'R10: the fourth delivery returns no work'
);

SELECT is(
  (SELECT status FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  'dead_lettered',
  'R11: the fourth delivery dead-letters the job'
);

SELECT is(
  (SELECT error_code FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  'TRANSCRIPTION_EXHAUSTED_RETRIES',
  'R12: the dead-letter records why'
);

SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs
   WHERE queue_name = 'transcription'
     AND pgmq_msg_id = (SELECT msg_id FROM _r_claim3)),
  1,
  'R13: exactly one failed_jobs row, not one per delivery'
);

-- Three provider calls happened, so three is what the dead-letter report must
-- say. The fourth delivery made no call and must not inflate the count.
SELECT is(
  (SELECT attempts FROM public.failed_jobs
   WHERE queue_name = 'transcription'
     AND pgmq_msg_id = (SELECT msg_id FROM _r_claim3)),
  3,
  'R14: failed_jobs records 3 attempts, not the 4th delivery'
);

SELECT is(
  (SELECT attempts FROM public.transcription_jobs WHERE id = (SELECT id FROM _f_job)),
  3,
  'R15: the job row is not advanced past the last real attempt either'
);

SELECT is(
  (SELECT count(*)::int FROM pgmq.q_transcription
   WHERE msg_id = (SELECT msg_id FROM _r_claim3)),
  0,
  'R16: the queue message is gone after the terminal path'
);

SELECT is(
  (SELECT count(*)::int FROM pgmq.a_transcription
   WHERE msg_id = (SELECT msg_id FROM _r_claim3)),
  1,
  'R17: a dead letter is archived, not silently deleted'
);

SELECT is(
  (SELECT job_type FROM public.failed_jobs
   WHERE queue_name = 'transcription'
     AND pgmq_msg_id = (SELECT msg_id FROM _r_claim3)),
  'TRANSCRIPTION',
  'R18: the dead-letter report can tell this job family from the other two'
);

-- --- Binding a job that was never bound -------------------------------------
--
-- process_inbound_message binds pgmq_msg_id at enqueue, so this branch is a
-- safety net for a job enqueued another way. Testing it means creating that
-- state deliberately.

CREATE TEMP TABLE _b_job AS SELECT pg_temp.deliver_audio('wamid.tw002') AS id;
CREATE TEMP TABLE _b_msg AS
SELECT pgmq_msg_id AS msg_id FROM public.transcription_jobs WHERE id = (SELECT id FROM _b_job);

UPDATE public.transcription_jobs SET pgmq_msg_id = NULL WHERE id = (SELECT id FROM _b_job);

SELECT pg_temp.only((SELECT msg_id FROM _b_msg));

CREATE TEMP TABLE _b_claim AS
SELECT msg_id FROM public.read_transcription_jobs(120, 1) LIMIT 1;

SELECT is(
  (SELECT msg_id FROM _b_claim),
  (SELECT msg_id FROM _b_msg),
  'R19a: the claim reached the intended message (control for R19)'
);

SELECT is(
  (SELECT pgmq_msg_id FROM public.transcription_jobs WHERE id = (SELECT id FROM _b_job)),
  (SELECT msg_id FROM _b_claim),
  'R19: an unbound job is bound to the message that claimed it'
);

-- --- Identity mismatch ------------------------------------------------------

UPDATE public.transcription_jobs
SET pgmq_msg_id = (SELECT msg_id FROM _b_claim) + 100000
WHERE id = (SELECT id FROM _b_job);

SELECT pg_temp.only((SELECT msg_id FROM _b_claim));

SELECT throws_ok(
  $$SELECT * FROM public.read_transcription_jobs(120, 1)$$,
  'P3I03',
  'TRANSCRIPTION_JOB_IDENTITY_MISMATCH',
  'R20: a job bound to a different queue message is refused'
);

-- --- Decreasing read_ct -----------------------------------------------------
--
-- read_ct is PGMQ's count and never decreases. Attempts above it means
-- something rewrote state underneath the worker.

UPDATE public.transcription_jobs
SET pgmq_msg_id = (SELECT msg_id FROM _b_claim), attempts = 99
WHERE id = (SELECT id FROM _b_job);

SELECT pg_temp.only((SELECT msg_id FROM _b_claim));

SELECT throws_ok(
  $$SELECT * FROM public.read_transcription_jobs(120, 1)$$,
  'P3I04',
  'INVALID_TRANSCRIPTION_ATTEMPTS',
  'R21: attempts ahead of read_ct is refused as corruption'
);

UPDATE public.transcription_jobs SET attempts = 1 WHERE id = (SELECT id FROM _b_job);

-- --- The claim's temp table, after a claim that raised -----------------------
--
-- read_transcription_jobs materializes its batch in a temp table so it can
-- SUBTRACT rows from it (R16, R23, R24: a completed job's message is deleted,
-- an exhausted one archived, and neither is returned as work). That pattern has
-- one failure mode worth pinning here
-- rather than trusting: R20 and R21 both raised *after* the CREATE TEMP TABLE,
-- and pgTAP catches through a savepoint. If the rolled-back CREATE had left
-- the relation behind, the next claim in this transaction — and the next claim
-- in any two reads batched into one PostgREST call — would die with "relation
-- already exists" instead of claiming work.
--
-- This is a real re-entry, not a formality: the message R21 failed on is still
-- visible (the raise rolled back its visibility-timeout push), so the claim
-- below takes it and runs the whole loop, including the DROP.
SELECT lives_ok(
  $$SELECT count(*) FROM public.read_transcription_jobs(120, 1)$$,
  'R21b: a claim after two raised claims still runs (no leaked temp relation)'
);

SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_class
   WHERE relnamespace = pg_catalog.pg_my_temp_schema()
     AND relname = '_transcription_claimed'),
  0,
  'R21c: and the relation is genuinely gone, not shadowed by a later create'
);

-- --- A finished job is not work ---------------------------------------------
--
-- The expensive case. A worker that completed the transcription and died
-- before deleting the message would, without this, download the media and pay
-- Gladia a second time before complete_transcription_job refused it.

CREATE TEMP TABLE _c_job AS SELECT pg_temp.deliver_audio('wamid.tw003') AS id;
CREATE TEMP TABLE _c_msg AS
SELECT pgmq_msg_id AS msg_id FROM public.transcription_jobs WHERE id = (SELECT id FROM _c_job);

SELECT lives_ok(
  format($$SELECT * FROM private.complete_transcription_job(%L::uuid, 'hola', 'gladia')$$,
    (SELECT id FROM _c_job)),
  'R22: the job completes (control: the message below is stale, not unclaimed)'
);

SELECT pg_temp.only((SELECT msg_id FROM _c_msg));

SELECT is(
  (SELECT count(*)::int FROM public.read_transcription_jobs(120, 1)),
  0,
  'R23: a completed job is not returned as work again'
);

SELECT is(
  (SELECT count(*)::int FROM pgmq.q_transcription WHERE msg_id = (SELECT msg_id FROM _c_msg)),
  0,
  'R24: its stale queue message is removed'
);

-- Deleted, not archived: a success is not a failure and must not appear
-- alongside the dead letters an operator reads.
SELECT is(
  (SELECT count(*)::int FROM pgmq.a_transcription WHERE msg_id = (SELECT msg_id FROM _c_msg)),
  0,
  'R25: a completed job''s message is deleted, not filed with the dead letters'
);

-- --- No job row -------------------------------------------------------------
--
-- Returned rather than swallowed: the worker archives it as an invalid
-- payload, which is where that decision belongs.

CREATE TEMP TABLE _orphan AS
SELECT pgmq.send('transcription',
  jsonb_build_object('transcriptionJobId', '00000000-0000-0000-0000-0000000000ff',
                     'requestId', 'orphan', 'timestamp', 'x'), 0) AS msg_id;

SELECT pg_temp.only((SELECT msg_id FROM _orphan));

SELECT is(
  (SELECT count(*)::int FROM public.read_transcription_jobs(120, 1)),
  1,
  'R26: a message whose job row is missing is still handed to the worker'
);

-- --- Argument validation ----------------------------------------------------

SELECT throws_ok(
  $$SELECT * FROM public.read_transcription_jobs(0, 1)$$,
  '90007',
  'INVALID_VISIBILITY_TIMEOUT',
  'R27: a zero visibility timeout is rejected'
);

SELECT throws_ok(
  $$SELECT * FROM public.read_transcription_jobs(3601, 1)$$,
  '90007',
  'INVALID_VISIBILITY_TIMEOUT',
  'R28: a visibility timeout above one hour is rejected'
);

-- ===========================================================================
-- A: archive_transcription_failed_job
-- ===========================================================================

CREATE TEMP TABLE _a_job AS SELECT pg_temp.deliver_audio('wamid.tw004') AS id;

-- Unclaimed: attempts = 0. failed_jobs.attempts is CHECK (attempts >= 1), and
-- the tempting fix is GREATEST(attempts, 1) -- which writes a number nobody
-- measured. Refusing is the honest answer.
SELECT throws_ok(
  format($$SELECT * FROM private.archive_transcription_failed_job(
    (SELECT pgmq_msg_id FROM public.transcription_jobs WHERE id = %L::uuid),
    %L::uuid, 'TRANSCRIPTION_INTERNAL_ERROR')$$,
    (SELECT id FROM _a_job), (SELECT id FROM _a_job)),
  'P3I04',
  'INVALID_TRANSCRIPTION_ATTEMPTS',
  'A1: a job no worker ever claimed cannot be dead-lettered'
);

SELECT pg_temp.only((SELECT pgmq_msg_id FROM public.transcription_jobs
                     WHERE id = (SELECT id FROM _a_job)));

CREATE TEMP TABLE _a_claim AS
SELECT msg_id FROM public.read_transcription_jobs(120, 1) LIMIT 1;

SELECT is(
  (SELECT msg_id FROM _a_claim),
  (SELECT pgmq_msg_id FROM public.transcription_jobs WHERE id = (SELECT id FROM _a_job)),
  'A2: the claim bound the message (control: A1 failed on attempts, not identity)'
);

SELECT throws_ok(
  format($$SELECT * FROM private.archive_transcription_failed_job(
    %L::bigint, %L::uuid, 'NOT_A_REAL_CODE')$$,
    (SELECT msg_id FROM _a_claim), (SELECT id FROM _a_job)),
  'P3I06',
  'INVALID_TRANSCRIPTION_FAILURE_CODE',
  'A3: an error code outside the allowlist is refused'
);

SELECT throws_ok(
  format($$SELECT * FROM private.archive_transcription_failed_job(
    %L::bigint, %L::uuid, NULL)$$,
    (SELECT msg_id FROM _a_claim), (SELECT id FROM _a_job)),
  'P3I06',
  'INVALID_TRANSCRIPTION_FAILURE_CODE',
  'A4: a NULL error code is refused rather than stored'
);

SELECT throws_ok(
  format($$SELECT * FROM private.archive_transcription_failed_job(
    %L::bigint, %L::uuid, 'TRANSCRIPTION_INTERNAL_ERROR')$$,
    (SELECT msg_id FROM _a_claim) + 500000, (SELECT id FROM _a_job)),
  'P3I03',
  'TRANSCRIPTION_JOB_IDENTITY_MISMATCH',
  'A5: archiving under a different message id is refused'
);

SELECT throws_ok(
  $$SELECT * FROM private.archive_transcription_failed_job(
    1::bigint, '00000000-0000-0000-0000-0000000000fe'::uuid,
    'TRANSCRIPTION_INTERNAL_ERROR')$$,
  'P3I01',
  'TRANSCRIPTION_JOB_NOT_FOUND',
  'A6: a job that does not exist cannot be dead-lettered'
);

-- The real archive, with a provider detail longer than the 512-char backstop.
CREATE TEMP TABLE _a_result AS
SELECT archived, already_archived
FROM private.archive_transcription_failed_job(
  (SELECT msg_id FROM _a_claim),
  (SELECT id FROM _a_job),
  'TRANSCRIPTION_PROVIDER_ERROR',
  pg_catalog.repeat('x', 900));

SELECT results_eq(
  $$SELECT archived, already_archived FROM _a_result$$,
  $$VALUES (true, false)$$,
  'A7: the first archive reports that it archived'
);

SELECT is(
  (SELECT pg_catalog.length(provider_error_detail) FROM public.failed_jobs
   WHERE queue_name = 'transcription' AND pgmq_msg_id = (SELECT msg_id FROM _a_claim)),
  512,
  'A8: an over-long provider detail is truncated to the column''s backstop'
);

SELECT is(
  (SELECT request_id FROM public.failed_jobs
   WHERE queue_name = 'transcription' AND pgmq_msg_id = (SELECT msg_id FROM _a_claim)),
  'transcribe-' || (SELECT source_message_id FROM public.transcription_jobs
                    WHERE id = (SELECT id FROM _a_job))::text,
  'A9: request_id is derived from stored state, matching the enqueue'
);

-- Idempotency, against the real constraint rather than a second insert attempt.
SELECT results_eq(
  format($$SELECT archived, already_archived
           FROM private.archive_transcription_failed_job(
             %L::bigint, %L::uuid, 'TRANSCRIPTION_PROVIDER_ERROR')$$,
    (SELECT msg_id FROM _a_claim), (SELECT id FROM _a_job)),
  $$VALUES (false, true)$$,
  'A10: a redelivered terminal message reports already-archived'
);

SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs
   WHERE queue_name = 'transcription' AND pgmq_msg_id = (SELECT msg_id FROM _a_claim)),
  1,
  'A11: and writes no second row'
);

-- Every code the worker can produce must be accepted by BOTH the RPC allowlist
-- and the failed_jobs CHECK. Asserted one at a time: a set comparison passes
-- while a single code is missing from one of the two lists, which is precisely
-- the 2026-08-19 defect.
CREATE TEMP TABLE _a_codes(code TEXT);
INSERT INTO _a_codes VALUES
  ('TRANSCRIPTION_EXHAUSTED_RETRIES'), ('TRANSCRIPTION_MEDIA_TOO_LARGE'),
  ('TRANSCRIPTION_MEDIA_UNAVAILABLE'), ('TRANSCRIPTION_MEDIA_AUTH_ERROR'),
  ('TRANSCRIPTION_PROVIDER_AUTH_ERROR'), ('TRANSCRIPTION_PROVIDER_CONFIG_ERROR'),
  ('TRANSCRIPTION_PROVIDER_ERROR'), ('TRANSCRIPTION_MALFORMED_RESPONSE'),
  ('TRANSCRIPTION_TIMEOUT'), ('TRANSCRIPTION_INTERNAL_ERROR');

CREATE FUNCTION pg_temp.archive_accepts(p_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_job_id UUID;
  v_msg_id BIGINT;
BEGIN
  v_job_id := pg_temp.deliver_audio('wamid.code-' || p_code);
  SELECT pgmq_msg_id INTO v_msg_id FROM public.transcription_jobs WHERE id = v_job_id;
  PERFORM pg_temp.only(v_msg_id);
  PERFORM public.read_transcription_jobs(120, 1);
  PERFORM private.archive_transcription_failed_job(v_msg_id, v_job_id, p_code);
  RETURN EXISTS (
    SELECT 1 FROM public.failed_jobs
    WHERE queue_name = 'transcription' AND pgmq_msg_id = v_msg_id AND error_code = p_code);
END;
$$;

SELECT is(
  (SELECT count(*)::int FROM _a_codes WHERE pg_temp.archive_accepts(code)),
  10,
  'A12: every terminal code the worker produces is accepted and stored'
);

-- A completed job has nothing to dead-letter, and the code says so distinctly
-- so the worker can discard the stale message instead of retrying.
CREATE TEMP TABLE _a_done AS SELECT pg_temp.deliver_audio('wamid.tw005') AS id;
SELECT pg_temp.only((SELECT pgmq_msg_id FROM public.transcription_jobs
                     WHERE id = (SELECT id FROM _a_done)));
SELECT public.read_transcription_jobs(120, 1);
SELECT private.complete_transcription_job((SELECT id FROM _a_done), 'listo', 'gladia');

SELECT throws_ok(
  format($$SELECT * FROM private.archive_transcription_failed_job(
    (SELECT pgmq_msg_id FROM public.transcription_jobs WHERE id = %L::uuid),
    %L::uuid, 'TRANSCRIPTION_INTERNAL_ERROR')$$,
    (SELECT id FROM _a_done), (SELECT id FROM _a_done)),
  'P3I05',
  'TRANSCRIPTION_ARCHIVE_STATE_ERROR',
  'A13: a completed job cannot be dead-lettered'
);

-- ===========================================================================
-- N: record_transcription_submission
--
-- The RPC that stands between a timeout and a second invoice. Gladia bills on
-- submission, so the provider's job id is the only handle that makes a
-- resumption possible; overwriting one orphans work that was already paid for.
-- ===========================================================================

CREATE TEMP TABLE _n_job AS SELECT pg_temp.deliver_audio('wamid.tw011') AS id;

SELECT throws_ok(
  format($$SELECT public.record_transcription_submission(%L::uuid, 'gladia', '')$$,
    (SELECT id FROM _n_job)),
  'P3I07',
  'INVALID_TRANSCRIPTION_SUBMISSION',
  'N1: an empty reference is refused rather than stored as a usable handle'
);

SELECT throws_ok(
  format($$SELECT public.record_transcription_submission(%L::uuid, 'gladia', NULL)$$,
    (SELECT id FROM _n_job)),
  'P3I07',
  'INVALID_TRANSCRIPTION_SUBMISSION',
  'N2: so is a NULL one'
);

SELECT throws_ok(
  $$SELECT public.record_transcription_submission(
    '00000000-0000-0000-0000-0000000000fc'::uuid, 'gladia', 'g-1')$$,
  'P3I01',
  'TRANSCRIPTION_JOB_NOT_FOUND',
  'N3: a reference cannot be recorded against a job that does not exist'
);

SELECT lives_ok(
  format($$SELECT public.record_transcription_submission(%L::uuid, 'gladia', 'gladia-job-1')$$,
    (SELECT id FROM _n_job)),
  'N4: the first submission is recorded'
);

SELECT results_eq(
  $$SELECT provider_job_reference, provider FROM public.transcription_jobs
    WHERE id = (SELECT id FROM _n_job)$$,
  $$VALUES ('gladia-job-1'::text, 'gladia'::text)$$,
  'N5: both the handle and the provider that issued it are stored'
);

-- The case the reference exists for: a redelivery of a job that was already
-- submitted must be able to say so without erroring, or the worker's only
-- option on resume is to submit again and pay again.
SELECT lives_ok(
  format($$SELECT public.record_transcription_submission(%L::uuid, 'gladia', 'gladia-job-1')$$,
    (SELECT id FROM _n_job)),
  'N6: re-recording the same reference is accepted, because that is a resume'
);

SELECT throws_ok(
  format($$SELECT public.record_transcription_submission(%L::uuid, 'gladia', 'gladia-job-2')$$,
    (SELECT id FROM _n_job)),
  'P3I08',
  'TRANSCRIPTION_SUBMISSION_ALREADY_RECORDED',
  'N7: a DIFFERENT reference is refused -- overwriting orphans billed work'
);

SELECT is(
  (SELECT provider_job_reference FROM public.transcription_jobs
   WHERE id = (SELECT id FROM _n_job)),
  'gladia-job-1',
  'N8: and the original handle survives the refusal'
);

-- ===========================================================================
-- S: skip_transcription_job
-- ===========================================================================

CREATE TEMP TABLE _s_job AS SELECT pg_temp.deliver_audio('wamid.tw006') AS id;
CREATE TEMP TABLE _s_msg AS
SELECT pgmq_msg_id AS msg_id FROM public.transcription_jobs WHERE id = (SELECT id FROM _s_job);

SELECT pg_temp.only((SELECT msg_id FROM _s_msg));
SELECT public.read_transcription_jobs(120, 1);

SELECT is(
  (SELECT private.skip_transcription_job(
    (SELECT id FROM _s_job), (SELECT msg_id FROM _s_msg), 'FEATURE_DISABLED')),
  true,
  'S1: a job can be skipped'
);

SELECT results_eq(
  $$SELECT status, skip_reason FROM public.transcription_jobs
    WHERE id = (SELECT id FROM _s_job)$$,
  $$VALUES ('skipped'::text, 'FEATURE_DISABLED'::text)$$,
  'S2: the skip is recorded with its reason'
);

SELECT is(
  (SELECT count(*)::int FROM pgmq.q_transcription WHERE msg_id = (SELECT msg_id FROM _s_msg)),
  0,
  'S3: the queue message is removed'
);

-- A skip is not a failure. It must not reach the dead-letter report, in either
-- of the two places an operator reads it.
SELECT is(
  (SELECT count(*)::int FROM pgmq.a_transcription WHERE msg_id = (SELECT msg_id FROM _s_msg)),
  0,
  'S4: a skip is deleted, not archived with the dead letters'
);

SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs
   WHERE queue_name = 'transcription' AND pgmq_msg_id = (SELECT msg_id FROM _s_msg)),
  0,
  'S5: and writes no failed_jobs row'
);

SELECT throws_ok(
  format($$SELECT private.skip_transcription_job(%L::uuid, %L::bigint, 'AGAIN')$$,
    (SELECT id FROM _s_job), (SELECT msg_id FROM _s_msg)),
  'P3I02',
  'TRANSCRIPTION_JOB_ALREADY_TERMINAL',
  'S6: a skipped job cannot be skipped again'
);

-- The one that would rewrite history: a completed transcript becoming
-- 'skipped' while its words stay on the message.
SELECT throws_ok(
  format($$SELECT private.skip_transcription_job(%L::uuid, 1::bigint, 'FEATURE_DISABLED')$$,
    (SELECT id FROM _a_done)),
  'P3I02',
  'TRANSCRIPTION_JOB_ALREADY_TERMINAL',
  'S7: a completed job cannot be skipped'
);

SELECT throws_ok(
  $$SELECT private.skip_transcription_job(
    '00000000-0000-0000-0000-0000000000fd'::uuid, 1::bigint, 'FEATURE_DISABLED')$$,
  'P3I01',
  'TRANSCRIPTION_JOB_NOT_FOUND',
  'S8: a job that does not exist cannot be skipped'
);

-- ===========================================================================
-- V: delete_transcription_job and set_transcription_visibility
-- ===========================================================================

CREATE TEMP TABLE _v_job AS SELECT pg_temp.deliver_audio('wamid.tw007') AS id;
CREATE TEMP TABLE _v_msg AS
SELECT pgmq_msg_id AS msg_id FROM public.transcription_jobs WHERE id = (SELECT id FROM _v_job);

SELECT is(
  (SELECT public.set_transcription_visibility((SELECT msg_id FROM _v_msg), 45)),
  true,
  'V1: the retry backoff extends a message''s lease'
);

SELECT ok(
  (SELECT EXTRACT(EPOCH FROM (vt - pg_catalog.now())) BETWEEN 40 AND 50
   FROM pgmq.q_transcription WHERE msg_id = (SELECT msg_id FROM _v_msg)),
  'V2: by the requested number of seconds'
);

SELECT throws_ok(
  $$SELECT public.set_transcription_visibility(1::bigint, 0)$$,
  '90007',
  'INVALID_VISIBILITY_TIMEOUT',
  'V3: a zero backoff is rejected'
);

SELECT throws_ok(
  $$SELECT public.set_transcription_visibility(1::bigint, 3601)$$,
  '90007',
  'INVALID_VISIBILITY_TIMEOUT',
  'V4: a backoff above one hour is rejected'
);

SELECT is(
  (SELECT public.delete_transcription_job((SELECT msg_id FROM _v_msg))),
  true,
  'V5: a processed message is deleted'
);

SELECT is(
  (SELECT count(*)::int FROM pgmq.q_transcription WHERE msg_id = (SELECT msg_id FROM _v_msg)),
  0,
  'V6: and is really gone'
);

SELECT is(
  (SELECT public.delete_transcription_job((SELECT msg_id FROM _v_msg))),
  false,
  'V7: deleting it twice reports false rather than raising'
);

-- ===========================================================================
-- W: the public wrappers reach the private functions
--
-- PostgREST cannot see the private schema, so a wrapper that does not reach
-- through is a worker that cannot work. Each is called exactly as the worker
-- calls it.
-- ===========================================================================

CREATE TEMP TABLE _w_job AS SELECT pg_temp.deliver_audio('wamid.tw008') AS id;
SELECT pg_temp.only((SELECT pgmq_msg_id FROM public.transcription_jobs
                     WHERE id = (SELECT id FROM _w_job)));
SELECT public.read_transcription_jobs(120, 1);

CREATE TEMP TABLE _w_complete AS
SELECT message_id, draft_enqueued
FROM public.complete_transcription_job(
  (SELECT id FROM _w_job), 'Quiero una cita el martes', 'gladia', 'gladia-ref-1', 'es');

SELECT is(
  (SELECT body_source FROM public.messages WHERE id = (SELECT message_id FROM _w_complete)),
  'machine_transcript',
  'W1: the public completion wrapper writes the transcript through'
);

SELECT is(
  (SELECT draft_enqueued FROM _w_complete),
  true,
  'W2: and returns the private function''s result unchanged'
);

SELECT is(
  (SELECT language_code FROM public.transcription_jobs WHERE id = (SELECT id FROM _w_job)),
  'es',
  'W3: every argument reaches the private function, including the last one'
);

CREATE TEMP TABLE _w_arch_job AS SELECT pg_temp.deliver_audio('wamid.tw009') AS id;
SELECT pg_temp.only((SELECT pgmq_msg_id FROM public.transcription_jobs
                     WHERE id = (SELECT id FROM _w_arch_job)));
SELECT public.read_transcription_jobs(120, 1);

SELECT results_eq(
  format($$SELECT archived, already_archived FROM public.archive_transcription_failed_job(
    (SELECT pgmq_msg_id FROM public.transcription_jobs WHERE id = %L::uuid),
    %L::uuid, 'TRANSCRIPTION_TIMEOUT')$$,
    (SELECT id FROM _w_arch_job), (SELECT id FROM _w_arch_job)),
  $$VALUES (true, false)$$,
  'W4: the public archive wrapper reaches the private function'
);

CREATE TEMP TABLE _w_skip_job AS SELECT pg_temp.deliver_audio('wamid.tw010') AS id;
SELECT pg_temp.only((SELECT pgmq_msg_id FROM public.transcription_jobs
                     WHERE id = (SELECT id FROM _w_skip_job)));
SELECT public.read_transcription_jobs(120, 1);

SELECT is(
  (SELECT public.skip_transcription_job(
    (SELECT id FROM _w_skip_job),
    (SELECT pgmq_msg_id FROM public.transcription_jobs WHERE id = (SELECT id FROM _w_skip_job)),
    'FEATURE_DISABLED')),
  true,
  'W5: the public skip wrapper reaches the private function'
);

-- Deliberately absent. private.fail_transcription_job increments attempts,
-- which predates this claim RPC and would double-count against read_ct; the
-- worker uses the visibility-timeout retry and the archive instead. An RPC the
-- worker must not call should not be reachable from the worker's client, and
-- an absence nobody tests is an absence that returns.
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fail_transcription_job'),
  'W6: fail_transcription_job is deliberately NOT exposed publicly'
);

SELECT has_function('private', 'fail_transcription_job',
  ARRAY['uuid', 'text', 'boolean'],
  'W7: and still exists privately, untouched (control for W6)');

-- ===========================================================================
-- P: permissions
-- ===========================================================================

SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND routine_name IN (
       'read_transcription_jobs', 'delete_transcription_job',
       'set_transcription_visibility', 'archive_transcription_failed_job',
       'skip_transcription_job', 'complete_transcription_job',
       'record_transcription_submission')
     AND grantee = 'service_role'
     AND privilege_type = 'EXECUTE'),
  7,
  'P1: service_role can execute all seven public transcription RPCs'
);

SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema IN ('public', 'private')
     AND routine_name IN (
       'read_transcription_jobs', 'delete_transcription_job',
       'set_transcription_visibility', 'archive_transcription_failed_job',
       'skip_transcription_job', 'complete_transcription_job',
       'record_transcription_submission', 'fail_transcription_job')
     AND grantee IN ('anon', 'authenticated', 'PUBLIC')),
  0,
  'P2: no browser role holds any privilege on any of them'
);

-- has_function_privilege resolves PUBLIC through the default ACL, which is
-- where an omitted REVOKE actually shows up: a function created without one
-- carries EXECUTE for PUBLIC and grants nothing explicitly, so P2 above would
-- pass while anon could still call it.
SELECT ok(
  NOT has_function_privilege('anon',
    'public.read_transcription_jobs(integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.read_transcription_jobs(integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.archive_transcription_failed_job(bigint,uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.skip_transcription_job(uuid,bigint,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.complete_transcription_job(uuid,text,text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.record_transcription_submission(uuid,text,text)', 'EXECUTE'),
  'P3: and cannot execute them through the PUBLIC default either'
);

SELECT ok(
  has_function_privilege('service_role',
    'public.read_transcription_jobs(integer,integer)', 'EXECUTE'),
  'P4: service_role can (control: P3 is not passing because nobody can)'
);

SELECT finish();
ROLLBACK;
