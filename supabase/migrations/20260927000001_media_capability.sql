-- ===========================================================================
-- Phase A item 1: media capability — queue, job table, worker RPCs.
--
-- Migration: 20260927000001_media_capability.sql
-- ADR: ADR-019 (docs/adr/ADR-019-media-generation-capability.md)
--
-- WHAT THIS SHIPS
--
--   * PGMQ queue `media_jobs` (grants mirror 20260804000008).
--   * `public.media_generation_jobs` — the org-scoped job table. RLS
--     ENABLED + FORCE, no policies: service_role only, like every other
--     operational table. Composite tenant FK pattern via
--     UNIQUE (id, organization_id), mirroring draft_generation_jobs.
--   * Concurrency guard: partial unique index
--     UNIQUE (organization_id) WHERE status IN ('queued','processing').
--     ADR-019 D5 records why the index won over an advisory lock, and why
--     the vocabulary says 'processing' where the approval said 'running'.
--   * Idempotent enqueue: UNIQUE (organization_id, idempotency_key)
--     WHERE idempotency_key IS NOT NULL.
--   * Private-logic / public-thin-wrapper RPCs, SECURITY DEFINER, locked
--     search_path, service_role-only grants — the shape every queue RPC in
--     this repo already uses (20260805000015, 20260805000018,
--     20260905000001).
--   * `failed_jobs` learns the media terminal vocabulary.
--   * Private Supabase Storage bucket `media` (greenfield — nothing exists).
--
-- WHAT THIS DELIBERATELY DOES NOT SHIP
--
--   * No `fail_media_job` RPC. Same reason 20260905000001 documents for
--     transcription: `read_media_jobs` reconciles attempts to PGMQ's
--     read_ct, so a second attempts-incrementing RPC would double-count.
--     Terminal failures go through `archive_media_failed_job`.
--   * No per-render metering table. ADR-019 D9: metering rides the
--     entitlement framework when it is wired; the enqueue RPC carries a
--     marked extension point instead of a parallel quota system.
--
-- ERROR CODES ADDED HERE (P3M family, shaped like P3B/P3I)
--
--   P3M01  MEDIA_JOB_NOT_FOUND
--   P3M02  MEDIA_JOB_ALREADY_TERMINAL
--   P3M03  MEDIA_JOB_IDENTITY_MISMATCH        (mirrors P3B08 / P3I03)
--   P3M04  INVALID_MEDIA_ATTEMPTS             (mirrors P3B16 / P3I04)
--   P3M05  MEDIA_ARCHIVE_STATE_ERROR          (mirrors P3B12 / P3I05)
--   P3M06  INVALID_MEDIA_FAILURE_CODE         (mirrors P3B15 / P3I06)
--   P3M07  INVALID_MEDIA_SUBMISSION           (empty prompt_id; mirrors P3I07)
--   P3M08  MEDIA_SUBMISSION_ALREADY_RECORDED  (mirrors P3I08)
--   P3M09  MEDIA_CONCURRENCY_EXCEEDED         (unique_violation mapping)
--   P3M10  MEDIA_FEATURE_DISABLED
--   P3M11  INVALID_MEDIA_JOB_STATE
--   P3M12  INVALID_MEDIA_PARAMS
--   P3M13  MEDIA_TENANT_MISMATCH              (mirrors P3B14)
--   P3M14  MEDIA_IDEMPOTENCY_CONFLICT         (same key, different request)
--   P3M15  MEDIA_RESULT_PATH_MISMATCH         (result_path not the job's kind-matched key)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. PGMQ queue `media_jobs`
-- ---------------------------------------------------------------------------

SELECT pgmq.create('media_jobs');

-- Re-grant to be safe (already granted in 20260804000008).
GRANT USAGE ON SCHEMA pgmq TO service_role;
REVOKE ALL ON SCHEMA pgmq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. media_generation_jobs table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.media_generation_jobs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  kind TEXT NOT NULL
    CHECK (kind IN ('image', 'video')),

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'skipped', 'cancelled', 'dead_lettered')),

  -- The user's prompt. 1..1000 chars enforced here AND in the adapter;
  -- the DB is the backstop, the adapter is the UX.
  prompt TEXT NOT NULL
    CHECK (char_length(prompt) BETWEEN 1 AND 1000),

  -- Validated render parameters. The adapter owns the schema
  -- ({ lane, width, height, frames, model_family, ... }); the DB stores it
  -- opaquely so a new lane does not require a migration.
  params JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(params) = 'object'),

  -- ComfyUI prompt id. Written by record_media_submission the moment ComfyUI
  -- accepts the job, BEFORE any polling — the handle that makes a timeout
  -- resumable instead of re-rendered.
  prompt_id TEXT,

  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0),
  pgmq_msg_id BIGINT,

  -- Who submitted the job. References public.profiles like
  -- organization_members does; the enqueue RPC membership-checks p_user_id,
  -- so a row here always names a member of the job's org at submit time.
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Lifecycle timestamps for audit and SLA: started_at is set when the
  -- worker claims the job, finished_at on every terminal transition.
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,

  -- GPU seconds the render consumed, reported by the worker on completion.
  -- NULL until then; the worker is the only writer.
  gpu_seconds NUMERIC
    CHECK (gpu_seconds IS NULL OR gpu_seconds >= 0),

  -- Idempotent submission: same key + org => same job, no second render.
  idempotency_key TEXT,

  error_code TEXT,
  -- Human-readable detail, capped. The worker sanitizes; this CHECK is the
  -- backstop so a drifted worker cannot violate the column contract.
  error_reason TEXT CHECK (error_reason IS NULL OR char_length(error_reason) <= 512),
  cancel_reason TEXT,
  skip_reason TEXT,

  -- Supabase Storage object key inside the private `media` bucket,
  -- e.g. <org_id>/<job_id>.png. The bucket name is NOT part of the key;
  -- complete_media_job enforces the exact <org_id>/<job_id>.<ext> shape.
  result_path TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Composite unique constraint for tenant-consistent FK target
-- (mirrors draft_generation_jobs_id_organization_unique).
ALTER TABLE public.media_generation_jobs
  ADD CONSTRAINT media_generation_jobs_id_organization_unique
  UNIQUE (id, organization_id);

-- Concurrency guard (ADR-019 D5): at most one queued-or-processing job per
-- organisation, enforced at the storage layer. NOT DEFERRABLE by default, so
-- the check is per-row and atomic — that atomicity is exactly what makes it
-- race-safe where a count-then-insert would not be.
CREATE UNIQUE INDEX IF NOT EXISTS media_generation_jobs_one_active_per_org
  ON public.media_generation_jobs (organization_id)
  WHERE status IN ('queued', 'processing');

-- Idempotent submission key, scoped per org.
CREATE UNIQUE INDEX IF NOT EXISTS media_generation_jobs_org_idempotency_unique
  ON public.media_generation_jobs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Nullable-unique pgmq_msg_id (null until enqueued), mirrors draft.
ALTER TABLE public.media_generation_jobs
  ADD CONSTRAINT media_generation_jobs_pgmq_msg_id_unique
  UNIQUE (pgmq_msg_id);

CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_org_id
  ON public.media_generation_jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_status
  ON public.media_generation_jobs(status);

-- RLS: ENABLED + FORCE, service-role only (operational table).
ALTER TABLE public.media_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_generation_jobs FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_generation_jobs TO service_role;
REVOKE ALL ON public.media_generation_jobs FROM authenticated, anon;

-- updated_at trigger (same function the draft table uses).
CREATE TRIGGER trigger_media_generation_jobs_updated_at
  BEFORE UPDATE ON public.media_generation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Private storage bucket `media` (greenfield)
-- ---------------------------------------------------------------------------
--
-- No bucket, policy, or signed-URL path exists anywhere in the repo. The
-- bucket is private; object keys live at <org_id>/<job_id>.<ext> INSIDE the
-- bucket (the bucket name is not part of the key). There are deliberately NO
-- storage.objects policies here: the worker and the API mint short-lived
-- signed URLs through the service_role client, which bypasses RLS.
-- Customer-facing read policies arrive with the API surface (Phase A
-- item 4), not ahead of it — an untested policy is a liability.

-- `public` is deliberately not listed: the column is absent from
-- storage.buckets in some Supabase Postgres builds (the CI `db start`
-- image rejects it with 42703), and its default is false everywhere, so
-- omitting it always yields the private bucket this section specifies.
INSERT INTO storage.buckets (id, name)
VALUES ('media', 'media')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. failed_jobs learns the media terminal vocabulary
-- ---------------------------------------------------------------------------
--
-- Only codes the worker can produce on a terminal archive. MEDIA_*_EXCEEDED /
-- DISABLED / PARAMS never appear here: an enqueue-time rejection creates no
-- queue message, so there is nothing to dead-letter. Cancellation is not
-- failure (ADR-019 open question 3): cancelled jobs never land here either.

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
      'TRANSCRIPTION_EXHAUSTED_RETRIES', 'TRANSCRIPTION_MEDIA_TOO_LARGE',
      'TRANSCRIPTION_MEDIA_UNAVAILABLE', 'TRANSCRIPTION_MEDIA_AUTH_ERROR',
      'TRANSCRIPTION_PROVIDER_AUTH_ERROR', 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR',
      'TRANSCRIPTION_PROVIDER_ERROR', 'TRANSCRIPTION_MALFORMED_RESPONSE',
      'TRANSCRIPTION_TIMEOUT', 'TRANSCRIPTION_INTERNAL_ERROR',
      -- Media error codes (20260927000001)
      --
      -- MEDIA_MODEL_UNAVAILABLE covers the fail-closed startup path surfacing
      -- per job: a required checkpoint/LoRA missing from /object_info, or an
      -- allowlist mismatch. It names the operator action (fix the host's
      -- model set), not "a provider problem".
      --
      -- MEDIA_STORAGE_ERROR is terminal on first occurrence: a result that
      -- cannot be written to the bucket will not write on retry, and the GPU
      -- minutes are already spent — retrying re-renders for nothing.
      'MEDIA_EXHAUSTED_RETRIES', 'MEDIA_PROVIDER_ERROR', 'MEDIA_TIMEOUT',
      'MEDIA_INTERNAL_ERROR', 'MEDIA_MODEL_UNAVAILABLE', 'MEDIA_STORAGE_ERROR'
    )
  );

-- ---------------------------------------------------------------------------
-- 5. private.enqueue_media_job — the only way to create a media job
-- ---------------------------------------------------------------------------
--
-- Called by the API layer through the public wrapper. The organisation is
-- supplied by the API (resolved from the session + x-tenant-id hint) AND
-- re-validated here against organization_members: a caller cannot name an
-- org it does not belong to. Isolation is guaranteed by the database, not
-- by trusting the caller — the same discipline as private.store_draft's
-- tenant checks.
--
-- Order of operations is load-bearing:
--   1. validate params (cheap, no side effects)
--   2. membership check (P3M13)
--   3. feature flag gate (P3M10) — the spend control
--   4. idempotency lookup — a resubmit must return the existing job, and
--      must do so BEFORE the INSERT, or the guard below would reject it.
--      Same key + different prompt/kind/params is MEDIA_IDEMPOTENCY_CONFLICT
--      (P3M14), never a silent return of the old job.
--   5. INSERT — the partial unique index fires here for a second active job
--   6. pgmq.send — only after the row exists, so a queue message can never
--      dangle without a job row
--
-- QUOTA EXTENSION POINT (ADR-019 D9): per-render metering rides the
-- entitlement framework when it is wired. The hook belongs here, between
-- steps 3 and 4: check the org's media entitlement and raise a
-- MEDIA_QUOTA_EXCEEDED-family code. Not implemented in item 1 — inventing a
-- parallel quota table would contradict D5's two-systems decision.

CREATE OR REPLACE FUNCTION private.enqueue_media_job(
  p_user_id UUID,
  p_organization_id UUID,
  p_kind TEXT,
  p_prompt TEXT,
  p_params JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE(job_id UUID, already_exists BOOLEAN, pgmq_msg_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job_id UUID;
  v_msg_id BIGINT;
  v_existing RECORD;
  v_prompt TEXT;
  v_idempotency_key TEXT;
BEGIN
  -- Normalise the idempotency key ONCE, up front. Every lookup and the
  -- INSERT below use v_idempotency_key; using the raw key anywhere would
  -- let ' abc' miss the existing row and die on the unique index instead
  -- of returning the existing job.
  v_idempotency_key := NULLIF(pg_catalog.btrim(p_idempotency_key), '');

  -- 1. Params first: no side effects before the request is known-valid.
  IF p_kind IS NULL OR p_kind NOT IN ('image', 'video') THEN
    RAISE EXCEPTION 'INVALID_MEDIA_PARAMS' USING ERRCODE = 'P3M12';
  END IF;
  v_prompt := pg_catalog.btrim(p_prompt);
  IF v_prompt IS NULL OR pg_catalog.char_length(v_prompt) < 1
     OR pg_catalog.char_length(v_prompt) > 1000 THEN
    RAISE EXCEPTION 'INVALID_MEDIA_PARAMS' USING ERRCODE = 'P3M12';
  END IF;
  IF p_params IS NULL OR pg_catalog.jsonb_typeof(p_params) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_MEDIA_PARAMS' USING ERRCODE = 'P3M12';
  END IF;

  -- 2. The caller must belong to the organisation it names.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = p_organization_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'MEDIA_TENANT_MISMATCH' USING ERRCODE = 'P3M13';
  END IF;

  -- 3. Flag gate: global AND org rows must be true; missing = disabled.
  IF NOT public.is_feature_enabled(p_organization_id, 'media_generation') THEN
    RAISE EXCEPTION 'MEDIA_FEATURE_DISABLED' USING ERRCODE = 'P3M10';
  END IF;

  -- 4. Idempotent resubmit: same key + org returns the existing job —
  -- but ONLY for the same request. A key reused with a different prompt,
  -- kind, or params is a caller bug (or a key collision), and silently
  -- returning the old job would hand back someone else's render.
  IF v_idempotency_key IS NOT NULL THEN
    SELECT id, media_generation_jobs.pgmq_msg_id, kind, prompt, params INTO v_existing
    FROM public.media_generation_jobs
    WHERE organization_id = p_organization_id
      AND idempotency_key = v_idempotency_key;
    IF FOUND THEN
      IF v_existing.kind <> p_kind
         OR v_existing.prompt <> v_prompt
         OR v_existing.params <> p_params THEN
        RAISE EXCEPTION 'MEDIA_IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P3M14';
      END IF;
      RETURN QUERY SELECT v_existing.id, TRUE, v_existing.pgmq_msg_id;
      RETURN;
    END IF;
  END IF;

  -- 5. INSERT. The partial unique index enforces one active job per org.
  BEGIN
    INSERT INTO public.media_generation_jobs (
      organization_id, created_by, kind, status, prompt, params,
      idempotency_key
    )
    VALUES (
      p_organization_id, p_user_id, p_kind, 'queued', v_prompt,
      p_params, v_idempotency_key
    )
    RETURNING id INTO v_job_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- Two constraints can raise this: the one-active-job guard, or the
      -- idempotency key in a lost-update race (two identical enqueues
      -- interleaved between step 4's lookup and step 5's insert). The
      -- second case is a resubmit that won nothing — return the winner,
      -- subject to the same conflict check as step 4.
      IF v_idempotency_key IS NOT NULL THEN
        SELECT id, media_generation_jobs.pgmq_msg_id, kind, prompt, params INTO v_existing
        FROM public.media_generation_jobs
        WHERE organization_id = p_organization_id
          AND idempotency_key = v_idempotency_key;
        IF FOUND THEN
          IF v_existing.kind <> p_kind
             OR v_existing.prompt <> v_prompt
             OR v_existing.params <> p_params THEN
            RAISE EXCEPTION 'MEDIA_IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P3M14';
          END IF;
          RETURN QUERY SELECT v_existing.id, TRUE, v_existing.pgmq_msg_id;
          RETURN;
        END IF;
      END IF;
      RAISE EXCEPTION 'MEDIA_CONCURRENCY_EXCEEDED' USING ERRCODE = 'P3M09';
  END;

  -- 6. Enqueue the PGMQ message. Metadata-only payload, mirroring the
  -- draft/transcription 3-field shape.
  SELECT pgmq.send(
    'media_jobs',
    jsonb_build_object(
      'mediaJobId', v_job_id,
      'requestId', 'media-' || v_job_id::text,
      'timestamp', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    0
  ) INTO v_msg_id;

  IF v_msg_id IS NULL THEN
    RAISE EXCEPTION 'QUEUE_SEND_FAILED' USING ERRCODE = '90005';
  END IF;

  UPDATE public.media_generation_jobs
  SET pgmq_msg_id = v_msg_id
  WHERE id = v_job_id;

  RETURN QUERY SELECT v_job_id, FALSE, v_msg_id;
END;
$$;

COMMENT ON FUNCTION private.enqueue_media_job IS
  'Creates a media_generation_jobs row and its media_jobs queue message '
  'atomically. Validates params, caller membership, and the media_generation '
  'flag; idempotent on (org, idempotency_key); maps the one-active-job guard '
  'to MEDIA_CONCURRENCY_EXCEEDED.';

CREATE OR REPLACE FUNCTION public.enqueue_media_job(
  p_user_id UUID,
  p_organization_id UUID,
  p_kind TEXT,
  p_prompt TEXT,
  p_params JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE(job_id UUID, already_exists BOOLEAN, pgmq_msg_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM private.enqueue_media_job(
    p_user_id, p_organization_id, p_kind, p_prompt, p_params, p_idempotency_key);
END;
$$;

COMMENT ON FUNCTION public.enqueue_media_job IS
  'Thin wrapper: the decisions live in private.enqueue_media_job. Exists '
  'because PostgREST cannot see the private schema.';

-- ---------------------------------------------------------------------------
-- 6. Worker claim cycle — read / set_visibility / delete
-- ---------------------------------------------------------------------------
--
-- Mirrors read_transcription_jobs (20260905000001), including the temp-table
-- pattern and its three checked failure modes (transactional DDL rollback,
-- re-entry in one transaction, cursor-safe deletes). Two divergences:
--
--   * Default visibility timeout is 600s, not 120s. A Lightning video takes
--     ~100s and the quality lane ~15min; the worker EXTENDS the lease via
--     set_media_visibility while ComfyUI reports queued/running, so 600s is
--     the backstop for a wedged poll loop, not the expected hold time.
--   * 'cancelled' joins the discard list: a job cancelled while its message
--     was still queued is deleted, never returned as work — cancellation is
--     not failure, so it is not archived.

CREATE OR REPLACE FUNCTION public.read_media_jobs(
  p_visibility_timeout_seconds INT DEFAULT 600,
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

  CREATE TEMP TABLE _media_claimed ON COMMIT DROP AS
  SELECT r.msg_id, r.read_ct, r.message AS payload, r.enqueued_at, r.vt
  FROM pgmq.read('media_jobs', p_visibility_timeout_seconds, v_limit) AS r;

  FOR v_row IN SELECT * FROM _media_claimed LOOP
    v_job_id := (v_row.payload->>'mediaJobId')::UUID;

    IF v_job_id IS NOT NULL THEN
      SELECT * INTO v_job
      FROM public.media_generation_jobs
      WHERE id = v_job_id
      FOR UPDATE;

      IF NOT FOUND THEN
        -- No job row: return the message and let the worker archive it as an
        -- invalid payload. Same choice the draft path makes.
        CONTINUE;
      END IF;

      -- 1. Queue/job identity
      IF v_job.pgmq_msg_id IS NULL THEN
        UPDATE public.media_generation_jobs
        SET pgmq_msg_id = v_row.msg_id
        WHERE id = v_job_id;
      ELSIF v_job.pgmq_msg_id <> v_row.msg_id THEN
        RAISE EXCEPTION 'MEDIA_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3M03';
      END IF;

      -- 2. A terminal (or cancelled) job is not work. Checked BEFORE attempts
      -- reconciliation: a finished job's attempt count is history.
      IF v_job.status IN ('completed', 'skipped', 'cancelled') THEN
        -- Finished or cancelled while queued; the worker died before
        -- deleting, or cancel_media_job ran after enqueue. Not a failure.
        PERFORM pgmq.delete('media_jobs', v_row.msg_id);
        DELETE FROM _media_claimed t WHERE t.msg_id = v_row.msg_id;
        CONTINUE;
      ELSIF v_job.status = 'dead_lettered' THEN
        PERFORM pgmq.archive('media_jobs', v_row.msg_id);
        DELETE FROM _media_claimed t WHERE t.msg_id = v_row.msg_id;
        CONTINUE;
      END IF;

      -- 3. read_ct is PGMQ's authoritative delivery count.
      IF v_row.read_ct < v_job.attempts THEN
        RAISE EXCEPTION 'INVALID_MEDIA_ATTEMPTS' USING ERRCODE = 'P3M04';
      ELSIF v_row.read_ct > v_job.attempts AND v_row.read_ct <= c_max_deliveries THEN
        UPDATE public.media_generation_jobs
        SET attempts = v_row.read_ct
        WHERE id = v_job_id;
      END IF;

      -- 4. The fourth delivery never becomes a fourth GPU render.
      IF v_row.read_ct > c_max_deliveries THEN
        SELECT archived, already_archived INTO v_term_archived, v_term_already
        FROM private.archive_media_failed_job(
          v_row.msg_id, v_job_id, 'MEDIA_EXHAUSTED_RETRIES', NULL);

        DELETE FROM _media_claimed t WHERE t.msg_id = v_row.msg_id;
        CONTINUE;
      END IF;

      -- 5. Claimed. started_at keeps the FIRST claim time across redeliveries.
      UPDATE public.media_generation_jobs
      SET status = 'processing',
          started_at = COALESCE(started_at, pg_catalog.now()),
          updated_at = pg_catalog.now()
      WHERE id = v_job_id;
    END IF;
  END LOOP;

  RETURN QUERY SELECT * FROM _media_claimed;

  DROP TABLE _media_claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_media_visibility(
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

  -- Lease heartbeat: the worker calls this while ComfyUI reports the prompt
  -- queued/running, so a 15-minute quality render never looks abandoned.
  v_record := pgmq.set_vt('media_jobs', p_msg_id, p_visibility_timeout_seconds);
  RETURN v_record IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_media_job(p_msg_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN pgmq.delete('media_jobs', p_msg_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. private.archive_media_failed_job — the terminal path
-- ---------------------------------------------------------------------------
--
-- Idempotent per (queue_name, pgmq_msg_id); attempts derived from the job
-- row, never supplied; refuses a never-claimed job rather than coercing
-- attempts=1. The error-code allowlist MUST stay a superset of the codes the
-- media worker can produce (ADR-019 D6).

CREATE OR REPLACE FUNCTION private.archive_media_failed_job(
  p_msg_id BIGINT,
  p_media_job_id UUID,
  p_error_code TEXT,
  p_provider_error_detail TEXT DEFAULT NULL
)
RETURNS TABLE(archived BOOLEAN, already_archived BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_queue_name CONSTANT TEXT := 'media_jobs';
  v_job_type   CONSTANT TEXT := 'MEDIA';
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
  FROM public.media_generation_jobs
  WHERE id = p_media_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEDIA_JOB_NOT_FOUND' USING ERRCODE = 'P3M01';
  END IF;

  -- A finished or cancelled job has nothing to dead-letter. Distinct code so
  -- the worker recognises a stale queue message and deletes it.
  IF v_job.status IN ('completed', 'skipped', 'cancelled') THEN
    RAISE EXCEPTION 'MEDIA_ARCHIVE_STATE_ERROR' USING ERRCODE = 'P3M05';
  END IF;

  IF v_job.pgmq_msg_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_MEDIA_ATTEMPTS' USING ERRCODE = 'P3M04';
  END IF;
  IF v_job.pgmq_msg_id <> p_msg_id THEN
    RAISE EXCEPTION 'MEDIA_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3M03';
  END IF;

  IF v_job.attempts IS NULL OR v_job.attempts < 1 THEN
    RAISE EXCEPTION 'INVALID_MEDIA_ATTEMPTS' USING ERRCODE = 'P3M04';
  END IF;

  IF p_error_code IS NULL OR p_error_code NOT IN (
    'MEDIA_EXHAUSTED_RETRIES',
    'MEDIA_PROVIDER_ERROR',
    'MEDIA_TIMEOUT',
    'MEDIA_INTERNAL_ERROR',
    'MEDIA_MODEL_UNAVAILABLE',
    'MEDIA_STORAGE_ERROR'
  ) THEN
    RAISE EXCEPTION 'INVALID_MEDIA_FAILURE_CODE' USING ERRCODE = 'P3M06';
  END IF;

  -- Backstop truncation against the 512-char column CHECK.
  v_detail := NULLIF(pg_catalog.left(pg_catalog.btrim(p_provider_error_detail), 512), '');

  UPDATE public.media_generation_jobs
  SET status = 'dead_lettered',
      error_code = p_error_code,
      error_reason = v_detail,
      finished_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_media_job_id
    AND status NOT IN ('completed', 'skipped', 'cancelled');

  INSERT INTO public.failed_jobs (
    webhook_event_id, job_type, request_id, error_code,
    attempts, queue_name, pgmq_msg_id, provider_error_detail
  )
  VALUES (
    NULL, v_job_type, 'media-' || v_job.id::text, p_error_code,
    v_job.attempts, v_queue_name, p_msg_id, v_detail
  );

  v_archive_result := pgmq.archive(v_queue_name, p_msg_id);

  IF v_archive_result IS NULL OR v_archive_result = FALSE THEN
    RAISE EXCEPTION 'ARCHIVE_FAILED' USING ERRCODE = '90006';
  END IF;

  RETURN QUERY SELECT TRUE, FALSE;
END;
$$;

COMMENT ON FUNCTION private.archive_media_failed_job IS
  'Terminates a media job: dead-letters the row, records one failed_jobs '
  'entry, and archives the PGMQ message. Idempotent per queue message.';

CREATE OR REPLACE FUNCTION public.archive_media_failed_job(
  p_msg_id BIGINT,
  p_media_job_id UUID,
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
  SELECT * FROM private.archive_media_failed_job(
    p_msg_id, p_media_job_id, p_error_code, p_provider_error_detail);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. private.skip_media_job — termination that is not a failure
-- ---------------------------------------------------------------------------
--
-- A job enqueued while `media_generation` was on, reaching a worker after it
-- was turned off, is not a failure. The flag is the spend control (GPU
-- minutes); a skipped job must not render and must not appear in the
-- dead-letter report.

CREATE OR REPLACE FUNCTION private.skip_media_job(
  p_media_job_id UUID,
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
  FROM public.media_generation_jobs
  WHERE id = p_media_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEDIA_JOB_NOT_FOUND' USING ERRCODE = 'P3M01';
  END IF;

  IF v_job.status IN ('completed', 'skipped', 'cancelled', 'dead_lettered') THEN
    RAISE EXCEPTION 'MEDIA_JOB_ALREADY_TERMINAL' USING ERRCODE = 'P3M02';
  END IF;

  UPDATE public.media_generation_jobs
  SET status = 'skipped',
      skip_reason = p_skip_reason,
      finished_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_media_job_id;

  v_deleted := pgmq.delete('media_jobs', p_msg_id);

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.skip_media_job(
  p_media_job_id UUID,
  p_msg_id BIGINT,
  p_skip_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN private.skip_media_job(p_media_job_id, p_msg_id, p_skip_reason);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. public.record_media_submission — the handle to GPU work
-- ---------------------------------------------------------------------------
--
-- Written the moment ComfyUI accepts the prompt, BEFORE any polling. A render
-- is minutes of GPU time; a worker that loses the prompt_id has no recovery
-- except re-rendering, and a blind resubmit can double-render a job that is
-- already running. An RPC rather than a service_role UPDATE for one rule: a
-- prompt_id that is already set is NEVER overwritten — overwriting it orphans
-- the running render and replaces its handle, so the first run becomes both
-- unrecoverable and invisible. Re-recording the SAME prompt_id is fine: that
-- is what a redelivery looks like.

CREATE OR REPLACE FUNCTION public.record_media_submission(
  p_job_id UUID,
  p_prompt_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
BEGIN
  IF p_prompt_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_prompt_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_MEDIA_SUBMISSION' USING ERRCODE = 'P3M07';
  END IF;

  SELECT * INTO v_job
  FROM public.media_generation_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEDIA_JOB_NOT_FOUND' USING ERRCODE = 'P3M01';
  END IF;

  IF v_job.prompt_id IS NOT NULL
     AND v_job.prompt_id <> p_prompt_id THEN
    RAISE EXCEPTION 'MEDIA_SUBMISSION_ALREADY_RECORDED' USING ERRCODE = 'P3M08';
  END IF;

  UPDATE public.media_generation_jobs
  SET prompt_id = p_prompt_id,
      updated_at = pg_catalog.now()
  WHERE id = p_job_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. public.complete_media_job — success
-- ---------------------------------------------------------------------------
--
-- Only a job the worker actually claimed ('processing') with a recorded
-- prompt_id can complete. The result_path is the storage OBJECT KEY inside
-- the private `media` bucket — <org_id>/<job_id>.<ext> — and it must match
-- EXACTLY, including the extension for the job's kind (image → .png,
-- video → .mp4). The worker constructs it, but the database does not trust
-- the worker's string: a wrong org, wrong job, wrong extension, or a
-- 'media/'-prefixed legacy shape is rejected rather than recorded.

CREATE OR REPLACE FUNCTION public.complete_media_job(
  p_job_id UUID,
  p_result_path TEXT,
  p_gpu_seconds NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_expected TEXT;
BEGIN
  IF p_result_path IS NULL OR pg_catalog.length(pg_catalog.btrim(p_result_path)) = 0 THEN
    RAISE EXCEPTION 'INVALID_MEDIA_PARAMS' USING ERRCODE = 'P3M12';
  END IF;

  IF p_gpu_seconds IS NOT NULL AND p_gpu_seconds < 0 THEN
    RAISE EXCEPTION 'INVALID_MEDIA_PARAMS' USING ERRCODE = 'P3M12';
  END IF;

  SELECT * INTO v_job
  FROM public.media_generation_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEDIA_JOB_NOT_FOUND' USING ERRCODE = 'P3M01';
  END IF;

  IF v_job.status <> 'processing' THEN
    RAISE EXCEPTION 'INVALID_MEDIA_JOB_STATE' USING ERRCODE = 'P3M11';
  END IF;

  -- A completed render implies ComfyUI accepted the prompt; a job the worker
  -- claimed but never submitted has no result to record.
  IF v_job.prompt_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_MEDIA_SUBMISSION' USING ERRCODE = 'P3M07';
  END IF;

  -- Tenant check: the recorded path must be exactly this job's object key,
  -- with the extension for its kind. No prefix tricks, no other org's key,
  -- no other job's key, no video saved as .png.
  v_expected := v_job.organization_id::text || '/' || v_job.id::text ||
                CASE v_job.kind WHEN 'image' THEN '.png' ELSE '.mp4' END;
  IF p_result_path <> v_expected THEN
    RAISE EXCEPTION 'MEDIA_RESULT_PATH_MISMATCH' USING ERRCODE = 'P3M15';
  END IF;

  UPDATE public.media_generation_jobs
  SET status = 'completed',
      result_path = p_result_path,
      gpu_seconds = p_gpu_seconds,
      finished_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id;

  RETURN p_job_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. public.cancel_media_job — API-initiated cancellation
-- ---------------------------------------------------------------------------
--
-- Cancellation is a first-class terminal state, not a failure: cancelled jobs
-- never appear in failed_jobs. The caller is membership-checked like enqueue
-- (P3M13). A reason is required — "cancelled" without a reason is unauditable.
--
-- If the job's queue message is still queued, it is deleted here so the
-- worker never sees it. If the worker already claimed it ('processing'), the
-- message is already leased; the worker observes the 'cancelled' row on its
-- next poll and interrupts its own ComfyUI prompt (never a global
-- /interrupt — see ADR-019 D4). The claim RPC additionally discards
-- 'cancelled' jobs as a backstop.

CREATE OR REPLACE FUNCTION public.cancel_media_job(
  p_user_id UUID,
  p_job_id UUID,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_reason TEXT;
BEGIN
  v_reason := pg_catalog.btrim(p_reason);
  IF v_reason IS NULL OR pg_catalog.char_length(v_reason) < 1
     OR pg_catalog.char_length(v_reason) > 512 THEN
    RAISE EXCEPTION 'INVALID_MEDIA_PARAMS' USING ERRCODE = 'P3M12';
  END IF;

  SELECT * INTO v_job
  FROM public.media_generation_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEDIA_JOB_NOT_FOUND' USING ERRCODE = 'P3M01';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = v_job.organization_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'MEDIA_TENANT_MISMATCH' USING ERRCODE = 'P3M13';
  END IF;

  IF v_job.status NOT IN ('queued', 'processing') THEN
    RAISE EXCEPTION 'INVALID_MEDIA_JOB_STATE' USING ERRCODE = 'P3M11';
  END IF;

  UPDATE public.media_generation_jobs
  SET status = 'cancelled',
      cancel_reason = v_reason,
      finished_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id;

  -- Still queued: remove the message so it is never claimed.
  IF v_job.status = 'queued' AND v_job.pgmq_msg_id IS NOT NULL THEN
    PERFORM pgmq.delete('media_jobs', v_job.pgmq_msg_id);
  END IF;

  RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 12. Grants: service_role only, on every function
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION private.enqueue_media_job(UUID, UUID, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.enqueue_media_job(UUID, UUID, TEXT, TEXT, JSONB, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.enqueue_media_job(UUID, UUID, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_media_job(UUID, UUID, TEXT, TEXT, JSONB, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.read_media_jobs(INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_media_jobs(INT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.set_media_visibility(BIGINT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_media_visibility(BIGINT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.delete_media_job(BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_media_job(BIGINT) TO service_role;

REVOKE ALL ON FUNCTION private.archive_media_failed_job(BIGINT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.archive_media_failed_job(BIGINT, UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.archive_media_failed_job(BIGINT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_media_failed_job(BIGINT, UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION private.skip_media_job(UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.skip_media_job(UUID, BIGINT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.skip_media_job(UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.skip_media_job(UUID, BIGINT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.record_media_submission(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_media_submission(UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.complete_media_job(UUID, TEXT, NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_media_job(UUID, TEXT, NUMERIC)
  TO service_role;

REVOKE ALL ON FUNCTION public.cancel_media_job(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_media_job(UUID, UUID, TEXT) TO service_role;
