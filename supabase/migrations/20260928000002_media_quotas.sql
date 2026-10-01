-- 20260928000002_media_quotas.sql
--
-- Phase A item 4 (product path): per-organization media generation quotas —
-- a shared GPU-compute budget (the binding constraint) plus per-lane caps
-- (finer guardrails).
--
-- WHY A SHARED BUDGET. The quality video lane costs ~5x the GPU time of
-- the Lightning lane (see REFERENCE COSTS below). Per-lane job-count caps
-- alone cannot bound total GPU spend: an org at 20 lightning + 4 quality +
-- 200 images per day stays inside every per-lane cap while the lanes'
-- combined cost can still exceed what one GPU can serve. So the budget —
-- daily and monthly GPU-seconds — is the binding constraint: the sum of
-- reference costs over the org's jobs in the window, plus the new job's
-- reference cost, must not exceed it. The per-lane caps remain as finer
-- guardrails (e.g. to keep one lane from starving the others), but the
-- budget is what rules out cross-lane over-admission.
--
-- RECONCILIATION INVARIANT. The budget binds; the per-lane caps refine.
-- At the proposed (UNAPPROVED — see below) budget of 2,000 GPU-s/day and
-- 40,000 GPU-s/month, the consistent per-lane caps are 20/400 lightning,
-- 4/80 quality, 200/4000 images — each lane's cap times its reference
-- cost equals the budget, so no single lane can exhaust it alone and no
-- mix of lanes within their caps can exceed it. Any future change to the
-- reference costs or the budget must re-derive the caps the same way.
--
-- REFERENCE COSTS (GPU-seconds per job, by lane). Documented as
-- UNMEASURED estimates pending the authorized live run; all three are
-- replaced by measured latencies afterward.
--
--   lightning 100 — the measured wall-clock from the host's earlier
--     reference run of the Lightning workflow (1280x720x81, 4-step LoRA).
--     This is the only grounded figure.
--   quality   500 — estimated at ~5x Lightning. Same 14B WAN model, same
--     81 frames at 1280x720, same two-stage high/low-noise graph; the
--     difference is 20 denoising steps (10+10) vs 4, i.e. ~5x the UNet
--     forward passes. Fixed costs (VAE decode, text encoding) do not
--     scale with steps, so the true ratio is likely 4-5x; 500 is the
--     conservative end.
--   image      10 — the least grounded: FLUX.1-schnell step count on the
--     host is unmeasured.
--
-- WHAT THIS ADDS
--
--   * `public.media_quotas` — one row per organization:
--       daily_lightning_limit / monthly_lightning_limit
--       daily_quality_limit   / monthly_quality_limit
--       daily_image_limit     / monthly_image_limit
--       daily_gpu_seconds_limit / monthly_gpu_seconds_limit
--     NULL means no cap; a missing row means no caps at all. There are
--     deliberately NO numeric defaults and NO seed rows: limits are a
--     launch decision, not a schema decision (see ADR-019 open question
--     Q4). A limit of 0 is meaningful — it disables that lane / any new
--     submission — and is distinct from NULL (unlimited).
--
--   * `private.media_lane_gpu_seconds(p_lane)` — the reference cost per
--     lane (100/500/10, IMMUTABLE). Single source of truth for the
--     budget accounting; the API never invents its own costs.
--
--   * `public.check_media_quota(p_organization_id, p_kind, p_lane,
--     p_idempotency_key DEFAULT NULL)` — SECURITY DEFINER, service_role
--     only. Validates the kind/lane pair, takes a transaction-scoped
--     advisory lock on the org first so concurrent submissions serialize
--     their quota checks instead of both reading a stale count, then:
--       1. idempotent replay bypass: if p_idempotency_key matches an
--          existing job for the org, return without enforcing — a retry
--          must not be quota-rejected. (The enqueue step still returns
--          the existing job or raises P3M14 MEDIA_IDEMPOTENCY_CONFLICT on
--          a params mismatch.)
--       2. per-lane count enforcement against the lane's daily/monthly
--          caps;
--       3. shared-budget enforcement: sum of reference GPU-s over the
--          org's non-skipped jobs created today (UTC) / this calendar
--          month, plus this job's reference cost, must not exceed the
--          configured budget.
--     A reached lane cap or an exceeded budget raises SQLSTATE P3M16 /
--     MEDIA_QUOTA_EXCEEDED with the lane in the exception detail
--     (`lane=<lane>`) so the API can name the lane in the 429.
--     Cancelled and dead-lettered jobs consume budget — they reached the
--     GPU (or burned a queue slot), and excluding them would let a
--     failing client retry for free. 'skipped' jobs never reached the
--     GPU and consume nothing.
--
--   * `public.submit_media_job(p_user_id, p_organization_id, p_kind,
--     p_prompt, p_params, p_idempotency_key)` — the atomic entry point.
--     SECURITY DEFINER, service_role only. Takes a transaction-scoped
--     advisory lock on the org, resolves and validates the lane
--     (image→image; video→params->>'lane', default 'lightning'; else
--     P3M12), calls check_media_quota, then calls
--     private.enqueue_media_job — which redoes params validation,
--     membership, the feature-flag gate, and idempotency handling, so
--     PR #4's function is not modified by this migration. Check +
--     reserve + enqueue happen in ONE database transaction: a
--     submission either passes quota and enqueues, or does neither.
--
-- LANE DETERMINATION. The lane is derived in exactly one way, everywhere:
--   CASE WHEN kind = 'image' THEN 'image'
--        ELSE COALESCE(params->>'lane', 'lightning') END
-- submit_media_job, check_media_quota, and the API's resolveMediaLane all
-- use it, so a stored row can never be counted against the wrong lane.
--
-- ON THE CALL ORDER. The API calls submit_media_job, never
-- check_media_quota directly. The advisory lock serializes the
-- check-then-enqueue per org; the one-active-job-per-org partial unique
-- index (20260927000001) remains the backstop against a burst that passes
-- the check and then races the enqueue. Quota enforcement is
-- intentionally NOT folded into enqueue_media_job itself: that migration
-- is the reviewed database checkpoint and is not modified by this one.
--
-- ON THE DAY/MONTH BOUNDARIES. Quota days are UTC days, not session
-- days: `date_trunc` on a timestamptz truncates in the session TimeZone,
-- so the boundary is computed as
--   date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
-- which is the UTC midnight instant regardless of TimeZone. A server
-- whose TimeZone drifts must not move any org's quota window.

-- ---------------------------------------------------------------------------
-- 1. media_quotas table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.media_quotas (
  organization_id UUID PRIMARY KEY
    REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- NULL = no cap for that lane. 0 = no submissions on that lane.
  -- Both deliberate; see header.
  daily_lightning_limit INTEGER
    CHECK (daily_lightning_limit IS NULL OR daily_lightning_limit >= 0),
  monthly_lightning_limit INTEGER
    CHECK (monthly_lightning_limit IS NULL OR monthly_lightning_limit >= 0),
  daily_quality_limit INTEGER
    CHECK (daily_quality_limit IS NULL OR daily_quality_limit >= 0),
  monthly_quality_limit INTEGER
    CHECK (monthly_quality_limit IS NULL OR monthly_quality_limit >= 0),
  daily_image_limit INTEGER
    CHECK (daily_image_limit IS NULL OR daily_image_limit >= 0),
  monthly_image_limit INTEGER
    CHECK (monthly_image_limit IS NULL OR monthly_image_limit >= 0),

  -- The shared GPU-compute budget: the BINDING constraint across lanes.
  -- NULL = no budget cap (unlimited). 0 = no new submissions at all.
  daily_gpu_seconds_limit INTEGER
    CHECK (daily_gpu_seconds_limit IS NULL OR daily_gpu_seconds_limit >= 0),
  monthly_gpu_seconds_limit INTEGER
    CHECK (monthly_gpu_seconds_limit IS NULL OR monthly_gpu_seconds_limit >= 0),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.media_quotas IS
  'Per-organization media generation quotas. Six per-lane caps '
  '(lightning / quality video lanes, image lane) act as finer guardrails; '
  'daily/monthly GPU-seconds budgets are the binding constraint across '
  'lanes. NULL limit or missing row = no cap. Limits are configured, never '
  'hard-coded: no numeric defaults, no seed rows.';

-- RLS: no policies, default deny. Only SECURITY DEFINER functions read this
-- table, and service_role bypasses RLS; no client role may read or write it.
ALTER TABLE public.media_quotas ENABLE ROW LEVEL SECURITY;

-- Table privilege hygiene (see table_privilege_hygiene.test.sql): new tables
-- arrive with default privileges; strip them explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_quotas TO service_role;
REVOKE ALL ON public.media_quotas FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. private.media_lane_gpu_seconds — reference cost per lane
-- ---------------------------------------------------------------------------

-- Single source of truth for the budget accounting. IMMUTABLE: the values
-- are planning weights, replaced by measured latencies after the
-- authorized live run (see the REFERENCE COSTS note in this file's
-- header). Private schema: not visible to PostgREST.
CREATE OR REPLACE FUNCTION private.media_lane_gpu_seconds(p_lane TEXT)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_lane
    WHEN 'lightning' THEN 100
    WHEN 'quality'   THEN 500
    WHEN 'image'     THEN 10
    ELSE NULL
  END
$$;

COMMENT ON FUNCTION private.media_lane_gpu_seconds(TEXT) IS
  'Reference GPU-seconds per media lane (lightning 100, quality 500, '
  'image 10). UNMEASURED estimates — see 20260928000002 header. Used by '
  'check_media_quota for the shared-budget accounting.';

-- ---------------------------------------------------------------------------
-- 3. check_media_quota
-- ---------------------------------------------------------------------------

-- This migration replaces the 3-argument signature (per-lane only) with the
-- 4-argument one (per-lane + shared budget + idempotent-replay bypass).
-- The 3-argument form was never pushed; drop it so only one signature
-- exists.
DROP FUNCTION IF EXISTS public.check_media_quota(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.check_media_quota(
  p_organization_id UUID,
  p_kind TEXT,
  p_lane TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_idempotency_key TEXT;
  v_daily_limit INTEGER;
  v_monthly_limit INTEGER;
  v_daily_gpu_limit INTEGER;
  v_monthly_gpu_limit INTEGER;
  v_daily_count INTEGER;
  v_monthly_count INTEGER;
  v_daily_gpu INTEGER;
  v_monthly_gpu INTEGER;
  v_ref_cost INTEGER;
  v_day_start TIMESTAMPTZ;
  v_month_start TIMESTAMPTZ;
BEGIN
  -- The kind/lane pair must be one the API can produce: image jobs are
  -- always the image lane; video jobs are the lightning or quality lane.
  -- Anything else is a caller bug — fail before touching the lock.
  IF p_kind NOT IN ('image', 'video')
     OR p_lane NOT IN ('image', 'lightning', 'quality')
     OR (p_kind = 'image' AND p_lane <> 'image')
     OR (p_kind = 'video' AND p_lane NOT IN ('lightning', 'quality')) THEN
    RAISE EXCEPTION 'INVALID_MEDIA_REQUEST'
      USING ERRCODE = 'P3M12',
            DETAIL = pg_catalog.format('kind=%s lane=%s', p_kind, p_lane);
  END IF;

  -- Serialize concurrent quota checks for the same org. Transaction-scoped:
  -- it is held only for this call, which is the whole point — two
  -- submissions racing each other must not both read the count before
  -- either one's job row is visible.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('media_quota:' || p_organization_id::text));

  -- Idempotent replay bypass, mirroring private.enqueue_media_job's key
  -- normalization exactly (NULLIF(btrim(key), '')). A retry carrying a
  -- key that already produced a job for this org is not a new unit of
  -- work: it must not be quota-rejected. The enqueue step still returns
  -- the existing job, or raises P3M14 on a kind/prompt/params mismatch.
  v_idempotency_key := NULLIF(pg_catalog.btrim(p_idempotency_key), '');
  IF v_idempotency_key IS NOT NULL THEN
    PERFORM 1
      FROM public.media_generation_jobs
     WHERE organization_id = p_organization_id
       AND idempotency_key = v_idempotency_key;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  SELECT
    CASE p_lane
      WHEN 'lightning' THEN daily_lightning_limit
      WHEN 'quality'   THEN daily_quality_limit
      WHEN 'image'     THEN daily_image_limit
    END,
    CASE p_lane
      WHEN 'lightning' THEN monthly_lightning_limit
      WHEN 'quality'   THEN monthly_quality_limit
      WHEN 'image'     THEN monthly_image_limit
    END,
    daily_gpu_seconds_limit,
    monthly_gpu_seconds_limit
    INTO v_daily_limit, v_monthly_limit, v_daily_gpu_limit, v_monthly_gpu_limit
    FROM public.media_quotas
   WHERE organization_id = p_organization_id;

  -- Missing row: no caps configured. All NULL: same. Either is the
  -- "not yet configured" state and must not block submissions.
  IF v_daily_limit IS NULL AND v_monthly_limit IS NULL
     AND v_daily_gpu_limit IS NULL AND v_monthly_gpu_limit IS NULL THEN
    RETURN;
  END IF;

  -- UTC boundaries. See the header note on why the double AT TIME ZONE
  -- is load-bearing.
  v_day_start :=
    pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC';
  v_month_start :=
    pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC';

  v_ref_cost := private.media_lane_gpu_seconds(p_lane);

  -- A job's lane is re-derived exactly the way the API resolves it, so a
  -- stored row can never be counted against the wrong lane. Skipped jobs
  -- never reached the GPU: they consume neither lane quota nor budget.
  -- Cancelled and dead-lettered jobs DID consume GPU/queue resources, so
  -- they count toward the budget (retry-burn abuse is priced in).
  IF v_daily_limit IS NOT NULL THEN
    SELECT pg_catalog.count(*) INTO v_daily_count
      FROM public.media_generation_jobs
     WHERE organization_id = p_organization_id
       AND status <> 'skipped'
       AND created_at >= v_day_start
       AND (CASE WHEN kind = 'image' THEN 'image'
                 ELSE coalesce(params->>'lane', 'lightning')
            END) = p_lane;
    IF v_daily_count >= v_daily_limit THEN
      RAISE EXCEPTION 'MEDIA_QUOTA_EXCEEDED'
        USING ERRCODE = 'P3M16',
              DETAIL = 'lane=' || p_lane;
    END IF;
  END IF;

  IF v_monthly_limit IS NOT NULL THEN
    SELECT pg_catalog.count(*) INTO v_monthly_count
      FROM public.media_generation_jobs
     WHERE organization_id = p_organization_id
       AND status <> 'skipped'
       AND created_at >= v_month_start
       AND (CASE WHEN kind = 'image' THEN 'image'
                 ELSE coalesce(params->>'lane', 'lightning')
            END) = p_lane;
    IF v_monthly_count >= v_monthly_limit THEN
      RAISE EXCEPTION 'MEDIA_QUOTA_EXCEEDED'
        USING ERRCODE = 'P3M16',
              DETAIL = 'lane=' || p_lane;
    END IF;
  END IF;

  -- Shared GPU-compute budget: the binding constraint across lanes. The
  -- admitted usage plus this job's reference cost must not exceed it.
  IF v_daily_gpu_limit IS NOT NULL THEN
    SELECT coalesce(pg_catalog.sum(
      private.media_lane_gpu_seconds(
        CASE WHEN kind = 'image' THEN 'image'
             ELSE coalesce(params->>'lane', 'lightning')
        END)), 0) INTO v_daily_gpu
      FROM public.media_generation_jobs
     WHERE organization_id = p_organization_id
       AND status <> 'skipped'
       AND created_at >= v_day_start;
    IF v_daily_gpu + v_ref_cost > v_daily_gpu_limit THEN
      RAISE EXCEPTION 'MEDIA_QUOTA_EXCEEDED'
        USING ERRCODE = 'P3M16',
              DETAIL = 'lane=' || p_lane;
    END IF;
  END IF;

  IF v_monthly_gpu_limit IS NOT NULL THEN
    SELECT coalesce(pg_catalog.sum(
      private.media_lane_gpu_seconds(
        CASE WHEN kind = 'image' THEN 'image'
             ELSE coalesce(params->>'lane', 'lightning')
        END)), 0) INTO v_monthly_gpu
      FROM public.media_generation_jobs
     WHERE organization_id = p_organization_id
       AND status <> 'skipped'
       AND created_at >= v_month_start;
    IF v_monthly_gpu + v_ref_cost > v_monthly_gpu_limit THEN
      RAISE EXCEPTION 'MEDIA_QUOTA_EXCEEDED'
        USING ERRCODE = 'P3M16',
              DETAIL = 'lane=' || p_lane;
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.check_media_quota(UUID, TEXT, TEXT, TEXT) IS
  'Quota gate for media submissions. Validates the kind/lane pair, '
  'advisory-locks per org, bypasses enforcement for idempotent replays, '
  'enforces the lane''s daily/monthly caps, then enforces the shared '
  'GPU-seconds budget (binding across lanes). Raises P3M16 '
  '(MEDIA_QUOTA_EXCEEDED) with the lane in the detail when a cap is '
  'reached or the budget would be exceeded. Missing row or all-NULL '
  'limits = no caps. Called by submit_media_job (and directly by tests).';

REVOKE ALL ON FUNCTION public.check_media_quota(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_media_quota(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. submit_media_job — the atomic entry point
-- ---------------------------------------------------------------------------

-- One transaction, one advisory lock: lane validation + quota check +
-- reserve + enqueue are atomic. A submission either passes quota and
-- enqueues, or does neither — there is no window in which the quota was
-- checked but the job was not reserved.
CREATE OR REPLACE FUNCTION public.submit_media_job(
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
  v_lane TEXT;
BEGIN
  -- Serialize whole submissions per org. check_media_quota takes its own
  -- 'media_quota:' lock inside; the order is always submit-then-quota,
  -- never reversed, so the two locks cannot deadlock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('media_submit:' || p_organization_id::text));

  -- Resolve the lane exactly the way the budget accounting derives it.
  -- image jobs are always the image lane; video jobs read params.lane
  -- and default to 'lightning' (the adapter's prod default).
  IF p_kind = 'image' THEN
    v_lane := 'image';
  ELSIF p_kind = 'video' THEN
    v_lane := coalesce(p_params->>'lane', 'lightning');
  ELSE
    v_lane := NULL;
  END IF;

  -- Lane validation mirrors check_media_quota's pair check, so a bad lane
  -- fails here with P3M12 before any quota state is touched. (The check
  -- function re-validates; defense in depth, not a second source of
  -- truth — the pair rule lives in both places deliberately.)
  IF v_lane NOT IN ('image', 'lightning', 'quality')
     OR (p_kind = 'image' AND v_lane <> 'image')
     OR (p_kind = 'video' AND v_lane NOT IN ('lightning', 'quality')) THEN
    RAISE EXCEPTION 'INVALID_MEDIA_REQUEST'
      USING ERRCODE = 'P3M12',
            DETAIL = pg_catalog.format('kind=%s lane=%s', p_kind, v_lane);
  END IF;

  -- Quota gate (per-lane caps + shared budget, with the idempotent-replay
  -- bypass). Raises P3M16 before anything is reserved.
  PERFORM public.check_media_quota(
    p_organization_id, p_kind, v_lane, p_idempotency_key);

  -- Reserve: the enqueue redoes params validation, membership, the
  -- feature-flag gate, and idempotency handling (returns the existing job
  -- or raises P3M14 on conflict). PR #4's function is not modified.
  RETURN QUERY
    SELECT *
      FROM private.enqueue_media_job(
        p_user_id, p_organization_id, p_kind, p_prompt,
        p_params, p_idempotency_key);
END;
$$;

COMMENT ON FUNCTION public.submit_media_job(UUID, UUID, TEXT, TEXT, JSONB, TEXT) IS
  'Atomic media submission: advisory-locks per org, validates the lane, '
  'runs the quota gate (per-lane caps + shared GPU-seconds budget), then '
  'enqueues — all in one transaction. Returns (job_id, already_exists, '
  'pgmq_msg_id) like enqueue_media_job. The API''s only write path for '
  'new media jobs.';

REVOKE ALL ON FUNCTION public.submit_media_job(UUID, UUID, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_media_job(UUID, UUID, TEXT, TEXT, JSONB, TEXT) TO service_role;
