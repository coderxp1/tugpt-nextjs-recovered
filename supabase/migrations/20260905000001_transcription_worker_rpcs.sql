-- ===========================================================================
-- The RPCs the transcription worker needs to exist at all.
--
-- Migration: 20260905000001_transcription_worker_rpcs.sql
--
-- 20260903000008 built the transcript ingest path and said what it was not
-- building: "NO CONSUMER SHIPS HERE. The queue and the completion RPCs land
-- with nothing reading them." This is the consumer's half of that, and it is
-- a migration rather than worker code because of where the boundary sits:
--
--   * `complete_transcription_job` and `fail_transcription_job` live in the
--     `private` schema. PostgREST exposes only the API schemas, so the worker
--     cannot reach them at all today.
--
--   * Claiming work from PGMQ has to reconcile the queue's delivery count
--     against the job row under a lock. Done from the worker that is two round
--     trips with a window in between.
--
-- ---------------------------------------------------------------------------
-- 1. SHAPED LIKE THE DRAFT PATH, ON PURPOSE
-- ---------------------------------------------------------------------------
--
-- The draft queue RPCs (20260805000015, 20260805000018, 20260819000001)
-- already solved this problem, and the transcription queue has the same
-- failure modes. So this ships the same five verbs with the same contracts:
--
--     read_transcription_jobs        claim, reconciling attempts to read_ct
--     set_transcription_visibility   transient retry backoff
--     delete_transcription_job       success
--     archive_transcription_failed_job  terminal: dead-letter + failed_jobs
--     skip_transcription_job         not-a-failure termination
--
-- Plus one the draft path has no equivalent of, because draft generation is
-- synchronous and this is not:
--
--     record_transcription_submission  persist the provider's job id before
--                                      waiting, so a timeout is resumable
--                                      rather than payable twice
--
-- Mirroring rather than inventing is the whole point: the dead-letter runbook,
-- the operational queries and the worker tests all speak that vocabulary
-- already. Where this diverges from draft it is written down, at the divergence.
--
-- ---------------------------------------------------------------------------
-- 2. WHY private.fail_transcription_job IS NOT WIRED UP HERE
-- ---------------------------------------------------------------------------
--
-- 20260903000008 shipped `private.fail_transcription_job`, which increments
-- `attempts` and puts the job back to 'queued'. It was written before any
-- claim RPC existed, when the job row was the only place a delivery could be
-- counted.
--
-- It is now the second place. `read_transcription_jobs` reconciles `attempts`
-- to PGMQ's `read_ct`, which is authoritative, and a worker calling both would
-- count every delivery twice: the third failure would archive with attempts=4
-- for three provider calls. So the worker does what the draft worker does --
-- `set_transcription_visibility` for a transient retry, `archive` for a
-- terminal one -- and never calls it.
--
-- It is left in place and untouched (its tests still hold) rather than dropped,
-- because dropping a shipped function is a bigger change than not calling it,
-- and it remains correct for a caller that does not also claim through PGMQ.
-- There is deliberately NO public wrapper for it: an RPC the worker must not
-- call should not be reachable from the worker's client.
--
-- ---------------------------------------------------------------------------
-- 3. WHY DEAD LETTERS GO TO failed_jobs
-- ---------------------------------------------------------------------------
--
-- `transcription_jobs` already records `status = 'dead_lettered'` and an
-- error code, so this is not the only place the information exists. It is,
-- however, the place the dead-letter runbook looks -- `failed_jobs` is already
-- the union of the Phase 3A ingest vocabulary and the Phase 3B draft one,
-- grouped by comment. Adding a third group is how that table has grown twice
-- before; leaving transcription out would mean one job family whose failures
-- are invisible to the tooling built for the other two.
--
-- ---------------------------------------------------------------------------
-- 4. ERROR CODES ADDED HERE (P3I family, continuing 20260903000008)
-- ---------------------------------------------------------------------------
--
--   P3I03  TRANSCRIPTION_JOB_IDENTITY_MISMATCH  (mirrors P3B08)
--   P3I04  INVALID_TRANSCRIPTION_ATTEMPTS       (mirrors P3B16)
--   P3I05  TRANSCRIPTION_ARCHIVE_STATE_ERROR    (mirrors P3B12)
--   P3I06  INVALID_TRANSCRIPTION_FAILURE_CODE   (mirrors P3B15)
--   P3I07  INVALID_TRANSCRIPTION_SUBMISSION     (empty provider job reference)
--   P3I08  TRANSCRIPTION_SUBMISSION_ALREADY_RECORDED
--
-- P3I05 is distinct from P3I02 (already terminal) on purpose: the worker
-- reacts to it by deleting a stale queue message, exactly as the draft worker
-- reacts to P3B12, and it must be able to tell that case from a generic
-- failure.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- failed_jobs learns the transcription vocabulary
-- ---------------------------------------------------------------------------

ALTER TABLE public.failed_jobs
  DROP CONSTRAINT IF EXISTS failed_jobs_error_code_check;

ALTER TABLE public.failed_jobs
  ADD CONSTRAINT failed_jobs_error_code_check CHECK (
    error_code IN (
      -- Phase 3A error codes
      'INVALID_QUEUE_PAYLOAD', 'RECEIPT_NOT_FOUND', 'STAGING_NOT_FOUND',
      'INVALID_STAGING', 'UNSUPPORTED_MESSAGE_KIND', 'DB_TRANSIENT',
      -- Phase 3B draft error codes (provider/config)
      'DRAFT_PROVIDER_AUTH_ERROR', 'DRAFT_PROVIDER_CONFIG_ERROR',
      'DRAFT_MALFORMED_RESPONSE', 'DRAFT_EXHAUSTED_RETRIES',
      'DRAFT_INVALID_REQUEST', 'DRAFT_PROVIDER_EMPTY_OUTPUT',
      'DRAFT_PROVIDER_OUTPUT_TOO_LONG', 'DRAFT_INVALID_CONFIG',
      -- Phase 3B draft error codes (archive allowlist)
      'DRAFT_PROVIDER_ERROR', 'DRAFT_GENERATION_TIMEOUT',
      'DRAFT_QUOTA_EXCEEDED', 'DRAFT_INTERNAL_ERROR',
      -- Transcription error codes (20260905000001)
      --
      -- MEDIA_TOO_LARGE and MEDIA_UNAVAILABLE are terminal on the first
      -- attempt rather than retried: a voice note does not shrink, and a media
      -- id Meta will not serve does not start being served. Retrying either
      -- burns the budget to reach the same answer three times.
      --
      -- MEDIA_AUTH_ERROR is separate from PROVIDER_AUTH_ERROR, and
      -- PROVIDER_CONFIG_ERROR from both, because they name three different
      -- credentials and three different operator actions: fix the Meta Graph
      -- token, rotate the Gladia key, or put a Gladia key in the vault at all.
      -- One code covering them would make the dead-letter report say "an
      -- authentication problem" and leave the operator to find out which.
      'TRANSCRIPTION_EXHAUSTED_RETRIES', 'TRANSCRIPTION_MEDIA_TOO_LARGE',
      'TRANSCRIPTION_MEDIA_UNAVAILABLE', 'TRANSCRIPTION_MEDIA_AUTH_ERROR',
      'TRANSCRIPTION_PROVIDER_AUTH_ERROR', 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR',
      'TRANSCRIPTION_PROVIDER_ERROR', 'TRANSCRIPTION_MALFORMED_RESPONSE',
      'TRANSCRIPTION_TIMEOUT', 'TRANSCRIPTION_INTERNAL_ERROR'
    )
  );

-- ---------------------------------------------------------------------------
-- private.archive_transcription_failed_job -- the terminal path
-- ---------------------------------------------------------------------------
--
-- Idempotent on the queue message: `failed_jobs` is UNIQUE on
-- (queue_name, pgmq_msg_id), and a redelivered terminal message must not
-- produce a second row. Returns which happened so the caller can distinguish
-- "archived it" from "it was already archived", as the draft path does.
--
-- `attempts` is DERIVED from the job row, never supplied by the caller, and a
-- job that was never claimed (attempts < 1) is refused rather than recorded as
-- one attempt. failed_jobs.attempts is CHECK (attempts >= 1); satisfying that
-- by coercion would write a number nobody measured.
CREATE OR REPLACE FUNCTION private.archive_transcription_failed_job(
  p_msg_id BIGINT,
  p_transcription_job_id UUID,
  p_error_code TEXT,
  p_provider_error_detail TEXT DEFAULT NULL
)
RETURNS TABLE(archived BOOLEAN, already_archived BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_queue_name CONSTANT TEXT := 'transcription';
  v_job_type   CONSTANT TEXT := 'TRANSCRIPTION';
  v_existing_id UUID;
  v_job RECORD;
  v_detail TEXT;
  v_archive_result BOOLEAN;
BEGIN
  SELECT id INTO v_existing_id
  FROM public.failed_jobs
  WHERE queue_name = v_queue_name AND pgmq_msg_id = p_msg_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_job
  FROM public.transcription_jobs
  WHERE id = p_transcription_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_NOT_FOUND' USING ERRCODE = 'P3I01';
  END IF;

  -- A finished job has nothing to dead-letter. Distinct code from P3I02 so the
  -- worker can recognise a stale queue message and delete it.
  IF v_job.status IN ('completed', 'skipped') THEN
    RAISE EXCEPTION 'TRANSCRIPTION_ARCHIVE_STATE_ERROR' USING ERRCODE = 'P3I05';
  END IF;

  IF v_job.pgmq_msg_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_TRANSCRIPTION_ATTEMPTS' USING ERRCODE = 'P3I04';
  END IF;
  IF v_job.pgmq_msg_id <> p_msg_id THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3I03';
  END IF;

  IF v_job.attempts IS NULL OR v_job.attempts < 1 THEN
    RAISE EXCEPTION 'INVALID_TRANSCRIPTION_ATTEMPTS' USING ERRCODE = 'P3I04';
  END IF;

  -- Must stay a superset of TranscriptionErrorCode in
  -- apps/worker/src/transcription-rpc-error-codes.ts. The draft path learned
  -- this the expensive way on 2026-08-19: a worker producing codes the RPC
  -- rejected turned every terminal failure into three phantom retries.
  IF p_error_code IS NULL OR p_error_code NOT IN (
    'TRANSCRIPTION_EXHAUSTED_RETRIES',
    'TRANSCRIPTION_MEDIA_TOO_LARGE',
    'TRANSCRIPTION_MEDIA_UNAVAILABLE',
    'TRANSCRIPTION_MEDIA_AUTH_ERROR',
    'TRANSCRIPTION_PROVIDER_AUTH_ERROR',
    'TRANSCRIPTION_PROVIDER_CONFIG_ERROR',
    'TRANSCRIPTION_PROVIDER_ERROR',
    'TRANSCRIPTION_MALFORMED_RESPONSE',
    'TRANSCRIPTION_TIMEOUT',
    'TRANSCRIPTION_INTERNAL_ERROR'
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSCRIPTION_FAILURE_CODE' USING ERRCODE = 'P3I06';
  END IF;

  -- Backstop truncation. The adapter sanitizes and caps at 300 chars; this
  -- guarantees the 512-char CHECK cannot be violated if that cap ever drifts.
  v_detail := NULLIF(pg_catalog.left(pg_catalog.btrim(p_provider_error_detail), 512), '');

  UPDATE public.transcription_jobs
  SET status = 'dead_lettered',
      error_code = p_error_code,
      updated_at = pg_catalog.now()
  WHERE id = p_transcription_job_id
    AND status NOT IN ('completed', 'skipped');

  INSERT INTO public.failed_jobs (
    webhook_event_id, job_type, request_id, error_code,
    attempts, queue_name, pgmq_msg_id, provider_error_detail
  )
  VALUES (
    NULL, v_job_type, 'transcribe-' || v_job.source_message_id::text, p_error_code,
    v_job.attempts, v_queue_name, p_msg_id, v_detail
  );

  v_archive_result := pgmq.archive(v_queue_name, p_msg_id);

  IF v_archive_result IS NULL OR v_archive_result = FALSE THEN
    RAISE EXCEPTION 'ARCHIVE_FAILED' USING ERRCODE = '90006';
  END IF;

  RETURN QUERY SELECT TRUE, FALSE;
END;
$$;

COMMENT ON FUNCTION private.archive_transcription_failed_job IS
  'Terminates a transcription job: dead-letters the row, records one '
  'failed_jobs entry, and archives the PGMQ message. Idempotent per queue '
  'message. Attempts are derived from the job row, never supplied.';

-- ---------------------------------------------------------------------------
-- private.skip_transcription_job -- termination that is not a failure
-- ---------------------------------------------------------------------------
--
-- A job enqueued while `voice_transcription` was on, reaching a worker after
-- it was turned off, is not a failure and must not appear in the dead-letter
-- report. It also must not be transcribed: the flag is the spend control.
CREATE OR REPLACE FUNCTION private.skip_transcription_job(
  p_transcription_job_id UUID,
  p_msg_id BIGINT,
  p_skip_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_deleted BOOLEAN;
BEGIN
  SELECT * INTO v_job
  FROM public.transcription_jobs
  WHERE id = p_transcription_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_NOT_FOUND' USING ERRCODE = 'P3I01';
  END IF;

  -- Skipping a finished job would rewrite history: a completed transcript
  -- would become 'skipped' while its transcript stayed on the message.
  IF v_job.status IN ('completed', 'skipped', 'dead_lettered') THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_ALREADY_TERMINAL' USING ERRCODE = 'P3I02';
  END IF;

  UPDATE public.transcription_jobs
  SET status = 'skipped',
      skip_reason = p_skip_reason,
      updated_at = pg_catalog.now()
  WHERE id = p_transcription_job_id;

  v_deleted := pgmq.delete('transcription', p_msg_id);

  RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- public.read_transcription_jobs -- claiming work
-- ---------------------------------------------------------------------------
--
-- Reconciliation contract, identical to read_draft_generation_jobs:
--   Stored msg_id absent:      bind it to the actual PGMQ msg_id
--   Stored msg_id differs:     raise P3I03
--   read_ct < stored attempts: raise P3I04 (a decrease means corruption)
--   read_ct = stored attempts: same delivery, idempotent
--   read_ct > stored attempts: reconcile stored attempts to read_ct
--   read_ct > 3:               dead-letter, return no work, no fourth call
--
-- TWO DIVERGENCES FROM THE DRAFT VERSION, both because transcription bills per
-- submission and draft generation does not:
--
--   * A job already terminal is discarded here rather than returned. The draft
--     worker catches that case later, through the reservation status, and by
--     then it has only read rows. A transcription worker that got a completed
--     job back would download the media and pay Gladia again before
--     complete_transcription_job refused it with P3I02.
--
--   * The default visibility timeout is 120s, not 30s. An attempt downloads
--     media and then waits on Gladia, which the adapter allows up to 300s for.
--     A 30s lease hands the same job to a second worker while the first is
--     still legitimately waiting -- and Gladia bills on submission, so that is
--     two charges for one voice note.
CREATE OR REPLACE FUNCTION public.read_transcription_jobs(
  p_visibility_timeout_seconds INT DEFAULT 120,
  p_limit INT DEFAULT 1
)
RETURNS TABLE(
  msg_id BIGINT,
  read_ct INT,
  payload JSONB,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  c_max_deliveries CONSTANT INT := 3;
  v_limit INT := LEAST(GREATEST(p_limit, 1), 10);
  v_row RECORD;
  v_job RECORD;
  v_job_id UUID;
  v_term_archived BOOLEAN;
  v_term_already BOOLEAN;
BEGIN
  IF p_visibility_timeout_seconds < 1 OR p_visibility_timeout_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT' USING ERRCODE = '90007';
  END IF;

  -- WHY A TEMP TABLE. It is not decoration copied from _draft_claimed; it is
  -- what makes this function expressible at all. pgmq.read() has already
  -- committed the lease by the time its rows are in hand, and steps 2 and 4
  -- below have to SUBTRACT from that batch -- a completed job's message is deleted
  -- from the queue, a dead-lettered one is archived -- because a message whose
  -- job has finished is not work and must never reach a worker. A set-returning
  -- function called in a FOR loop cannot be subtracted from, so the batch is
  -- materialized once, edited, and read back by the RETURN QUERY below.
  --
  -- Three failure modes come with the pattern. Each was checked against
  -- PostgreSQL rather than assumed:
  --
  --   * ON COMMIT DROP and an exception. Creating a temp table is transactional
  --     DDL, so the rollback an escaped RAISE causes un-makes the table. That
  --     covers pgTAP too, whose throws_ok catches through a savepoint: a
  --     raised P3I03/P3I04 cannot leave the name behind for the next claim.
  --   * Re-entry in one transaction. The success path drops the table itself,
  --     so a second claim in the same transaction -- two reads batched into one
  --     PostgREST call, or two assertions in one pgTAP transaction -- does not
  --     die on "relation already exists". Pinned by R21b/R21c.
  --   * Deleting from a table an open cursor is scanning. Only the current row
  --     is deleted, which the cursor has already returned, and the loop inserts
  --     nothing, so no row is skipped or visited twice.
  --
  -- The explicit DROP at the bottom covers the one path a rollback does not: a
  -- claim that succeeded, in a transaction that is then reused for another
  -- claim. ON COMMIT DROP is the backstop for every path the DROP line is never
  -- reached on.
  CREATE TEMP TABLE _transcription_claimed ON COMMIT DROP AS
  SELECT r.msg_id, r.read_ct, r.message AS payload, r.enqueued_at, r.vt
  FROM pgmq.read('transcription', p_visibility_timeout_seconds, v_limit) AS r;

  FOR v_row IN SELECT * FROM _transcription_claimed LOOP
    v_job_id := (v_row.payload->>'transcriptionJobId')::UUID;

    IF v_job_id IS NOT NULL THEN
      SELECT * INTO v_job
      FROM public.transcription_jobs
      WHERE id = v_job_id
      FOR UPDATE;

      IF NOT FOUND THEN
        -- No job row: return the message and let the worker archive it as an
        -- invalid payload. Same choice the draft path makes.
        CONTINUE;
      END IF;

      -- 1. Queue/job identity
      IF v_job.pgmq_msg_id IS NULL THEN
        UPDATE public.transcription_jobs
        SET pgmq_msg_id = v_row.msg_id
        WHERE id = v_job_id;
      ELSIF v_job.pgmq_msg_id <> v_row.msg_id THEN
        RAISE EXCEPTION 'TRANSCRIPTION_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3I03';
      END IF;

      -- 2. A terminal job is not work. Checked BEFORE attempts reconciliation:
      -- a finished job's attempt count is history, not something to rewrite.
      IF v_job.status IN ('completed', 'skipped') THEN
        -- Finished successfully; the worker died before deleting. Not a
        -- failure, so it does not belong in the archive alongside dead letters.
        PERFORM pgmq.delete('transcription', v_row.msg_id);
        DELETE FROM _transcription_claimed t WHERE t.msg_id = v_row.msg_id;
        CONTINUE;
      ELSIF v_job.status = 'dead_lettered' THEN
        PERFORM pgmq.archive('transcription', v_row.msg_id);
        DELETE FROM _transcription_claimed t WHERE t.msg_id = v_row.msg_id;
        CONTINUE;
      END IF;

      -- 3. read_ct is PGMQ's authoritative delivery count. It never decreases;
      -- if it appears to, something has rewritten state underneath us.
      IF v_row.read_ct < v_job.attempts THEN
        RAISE EXCEPTION 'INVALID_TRANSCRIPTION_ATTEMPTS' USING ERRCODE = 'P3I04';
      ELSIF v_row.read_ct > v_job.attempts AND v_row.read_ct <= c_max_deliveries THEN
        -- Above the budget attempts is deliberately NOT advanced: the archive
        -- records the last real provider attempt count, not the delivery that
        -- never made a call.
        UPDATE public.transcription_jobs
        SET attempts = v_row.read_ct
        WHERE id = v_job_id;
      END IF;

      -- 4. The fourth delivery never becomes a fourth Gladia submission.
      IF v_row.read_ct > c_max_deliveries THEN
        SELECT archived, already_archived INTO v_term_archived, v_term_already
        FROM private.archive_transcription_failed_job(
          v_row.msg_id, v_job_id, 'TRANSCRIPTION_EXHAUSTED_RETRIES', NULL);

        DELETE FROM _transcription_claimed t WHERE t.msg_id = v_row.msg_id;
        CONTINUE;
      END IF;

      -- 5. Claimed. 'processing' is what an operator reads to see a job in
      -- flight, and unlike draft generation this one is spending money while
      -- it is.
      UPDATE public.transcription_jobs
      SET status = 'processing', updated_at = pg_catalog.now()
      WHERE id = v_job_id;
    END IF;
  END LOOP;

  RETURN QUERY SELECT * FROM _transcription_claimed;

  DROP TABLE _transcription_claimed;
END;
$$;

-- ---------------------------------------------------------------------------
-- public.record_transcription_submission -- the handle to billed work
-- ---------------------------------------------------------------------------
--
-- Written the moment Gladia accepts the job, BEFORE any polling. Everything
-- after acceptance is work the provider will bill for, so a worker that loses
-- the id has no recovery except paying again -- which is the entire reason
-- `transcription_jobs.provider_job_reference` exists and why the adapter has
-- an `onSubmitted` hook that fires before it waits.
--
-- An RPC rather than a service_role UPDATE, for one rule: a reference that is
-- already set is NEVER overwritten. Overwriting it orphans a billed job and
-- replaces its handle with a newer one, so the first charge becomes both
-- unrecoverable and invisible. A filtered UPDATE could express that, but it
-- would express it silently -- the worker would see "0 rows" and carry on,
-- when what it needs is to stop and be told.
CREATE OR REPLACE FUNCTION public.record_transcription_submission(
  p_job_id UUID,
  p_provider TEXT,
  p_provider_job_reference TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
BEGIN
  IF p_provider_job_reference IS NULL OR pg_catalog.length(pg_catalog.btrim(p_provider_job_reference)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSCRIPTION_SUBMISSION' USING ERRCODE = 'P3I07';
  END IF;

  SELECT * INTO v_job
  FROM public.transcription_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_NOT_FOUND' USING ERRCODE = 'P3I01';
  END IF;

  IF v_job.provider_job_reference IS NOT NULL
     AND v_job.provider_job_reference <> p_provider_job_reference THEN
    RAISE EXCEPTION 'TRANSCRIPTION_SUBMISSION_ALREADY_RECORDED' USING ERRCODE = 'P3I08';
  END IF;

  -- Re-recording the SAME reference is fine and deliberately not an error:
  -- that is what a redelivery of a job already submitted looks like, and it
  -- is exactly the case the reference exists to make safe.
  UPDATE public.transcription_jobs
  SET provider_job_reference = p_provider_job_reference,
      provider = COALESCE(p_provider, provider),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- public.delete_transcription_job -- success
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_transcription_job(p_msg_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN pgmq.delete('transcription', p_msg_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- public.set_transcription_visibility -- transient retry backoff
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_transcription_visibility(
  p_msg_id BIGINT,
  p_visibility_timeout_seconds INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_record pgmq.message_record;
BEGIN
  IF p_visibility_timeout_seconds < 1 OR p_visibility_timeout_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT' USING ERRCODE = '90007';
  END IF;

  v_record := pgmq.set_vt('transcription', p_msg_id, p_visibility_timeout_seconds);
  RETURN v_record IS NOT NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Public wrappers
-- ---------------------------------------------------------------------------
--
-- Thin on purpose: the decisions live in `private`, where they are written
-- once and tested once. These exist because PostgREST cannot see the private
-- schema, not to add behaviour. A wrapper that grew logic would mean the same
-- rule enforced in two places, which is how the two drift.

CREATE OR REPLACE FUNCTION public.archive_transcription_failed_job(
  p_msg_id BIGINT,
  p_transcription_job_id UUID,
  p_error_code TEXT,
  p_provider_error_detail TEXT DEFAULT NULL
)
RETURNS TABLE(archived BOOLEAN, already_archived BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM private.archive_transcription_failed_job(
    p_msg_id, p_transcription_job_id, p_error_code, p_provider_error_detail);
END;
$$;

CREATE OR REPLACE FUNCTION public.skip_transcription_job(
  p_transcription_job_id UUID,
  p_msg_id BIGINT,
  p_skip_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN private.skip_transcription_job(
    p_transcription_job_id, p_msg_id, p_skip_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_transcription_job(
  p_job_id UUID,
  p_transcript TEXT,
  p_provider TEXT,
  p_provider_job_reference TEXT DEFAULT NULL,
  p_language_code TEXT DEFAULT NULL
)
RETURNS TABLE(message_id UUID, draft_enqueued BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM private.complete_transcription_job(
    p_job_id, p_transcript, p_provider, p_provider_job_reference, p_language_code);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: service_role only, on every one of them
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION private.archive_transcription_failed_job(BIGINT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.archive_transcription_failed_job(BIGINT, UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION private.skip_transcription_job(UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.skip_transcription_job(UUID, BIGINT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.read_transcription_jobs(INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_transcription_jobs(INT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.delete_transcription_job(BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_transcription_job(BIGINT) TO service_role;

REVOKE ALL ON FUNCTION public.record_transcription_submission(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_transcription_submission(UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.set_transcription_visibility(BIGINT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_transcription_visibility(BIGINT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.archive_transcription_failed_job(BIGINT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_transcription_failed_job(BIGINT, UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.skip_transcription_job(UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.skip_transcription_job(UUID, BIGINT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.complete_transcription_job(UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_transcription_job(UUID, TEXT, TEXT, TEXT, TEXT)
  TO service_role;
