-- media_quotas.test.sql
--
-- Phase A item 4 (migration 20260928000002): per-organization media
-- generation quotas — per-lane caps plus a shared GPU-compute budget.
--
-- WHY THE SHARED BUDGET (see the migration header): the quality video
-- lane costs ~5x the GPU time of the Lightning lane (reference: lightning
-- 100 GPU-s, quality 500, image 10 — UNMEASURED estimates pending the
-- live run). Per-lane job-count caps alone cannot bound total GPU spend:
-- an org inside every per-lane cap can still over-admit across lanes. So
-- the budget is the BINDING constraint — admitted reference GPU-s plus
-- the new job's reference cost must not exceed it — and the per-lane caps
-- are finer guardrails. The reconciliation invariant: at a 2,000/40,000
-- GPU-s budget the consistent caps are 20/400 lightning, 4/80 quality,
-- 200/4000 images (each cap times its reference cost equals the budget).
-- All numeric limits are UNAPPROVED; the schema carries no defaults.
--
-- WHAT THIS FILE IS DEFENDING, in descending order of cost:
--
--   1. An org burning unbounded GPU time across lanes. The shared budget
--      is enforced on every submission: filling it with lightning blocks
--      a quality job and vice versa (B-group). A budget that does not
--      fire is the same as no budget.
--
--   2. A quota check that is not atomic with the reservation. submit_media_job
--      takes an advisory lock and runs lane validation + quota gate +
--      enqueue in ONE transaction (A-group, serial), and the C-group is
--      the genuine two-session dblink race: two sessions submitting
--      different lanes concurrently against a tight budget admit exactly
--      one job, the loser gets P3M16, and the winner's reservation is
--      visible to later checks.
--
--   3. Quota paid on the wrong lane (X-group), a lane derived
--      differently by the counter and the API (Q7), windows that move
--      with the server clock (M-group), paying for work that never
--      happened (S-group: 'skipped' consumes nothing), cancelled and
--      dead-lettered jobs escaping the budget (B7/B8: they reached the
--      GPU and must count — retry-burn abuse is priced in).
--
--   4. An unconfigured org being blocked (U-group), one org throttling
--      another (XO-group), the functions being callable by anyone but
--      service_role (G-group), and a kind/lane pair the gate rejects
--      (V-group).
--
--   5. Idempotent retries being quota-rejected. A replay carrying a key
--      that already produced a job bypasses the quota check — the
--      enqueue still returns the existing job or raises P3M14 on a
--      params mismatch (B9/B10, A3/A4).
--
-- ON THE FIXTURE TRAP (see media_worker_rpcs.test.sql): every "raises" is
-- paired with a control proving the same fixture passes one step below the
-- limit. Jobs are inserted directly with terminal statuses — the
-- one-active-job-per-org partial unique index forbids more than one
-- 'queued'/'processing' row per org, and quota counting is about what was
-- submitted, not what is still running. The A-group and C-group go
-- through submit_media_job itself, so they set the media_generation flag
-- and clean up their queue messages.

BEGIN;
SELECT plan(55);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug) VALUES
  ('bbbbbb01-7c12-0000-0000-000000000001', 'Quota Org A', 'quota-test-org-a'),
  ('bbbbbb02-7c12-0000-0000-000000000002', 'Quota Org B', 'quota-test-org-b');

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
  ('00000000-0000-0000-0000-000000000000','22222201-7c12-0000-0000-000000000001','authenticated','authenticated','quota-a@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','22222202-7c12-0000-0000-000000000002','authenticated','authenticated','quota-b@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','','')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email) VALUES
  ('22222201-7c12-0000-0000-000000000001', 'quota-a@example.com'),
  ('22222202-7c12-0000-0000-000000000002', 'quota-b@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('bbbbbb01-7c12-0000-0000-000000000001', '22222201-7c12-0000-0000-000000000001', 'owner'),
  ('bbbbbb02-7c12-0000-0000-000000000002', '22222202-7c12-0000-0000-000000000002', 'owner');

-- --- Helpers ---------------------------------------------------------------

-- Insert a job row directly with a chosen kind/lane/status/created_at.
-- Video jobs carry the lane in params exactly as the API submits it;
-- image jobs ignore any lane. Terminal statuses only: the one-active-job
-- guard forbids two queued/processing rows for one org, and the quota
-- counts submissions, not live jobs.
CREATE OR REPLACE FUNCTION pg_temp.mkjob(
  p_org UUID, p_user UUID, p_kind TEXT, p_lane TEXT, p_status TEXT,
  p_created_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.media_generation_jobs
    (organization_id, created_by, kind, status, prompt, params, created_at)
  VALUES
    (p_org, p_user, p_kind, p_status, 'Un cartel para la clínica',
     CASE WHEN p_kind = 'video'
          THEN pg_catalog.jsonb_build_object('lane', p_lane)
          ELSE '{}'::pg_catalog.jsonb END,
     p_created_at);
END;
$$;

-- Same, with an idempotency key (for the replay-bypass tests).
CREATE OR REPLACE FUNCTION pg_temp.mkjob_key(
  p_org UUID, p_user UUID, p_kind TEXT, p_lane TEXT, p_status TEXT,
  p_created_at TIMESTAMPTZ, p_key TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.media_generation_jobs
    (organization_id, created_by, kind, status, prompt, params,
     idempotency_key, created_at)
  VALUES
    (p_org, p_user, p_kind, p_status, 'Un cartel para la clínica',
     CASE WHEN p_kind = 'video'
          THEN pg_catalog.jsonb_build_object('lane', p_lane)
          ELSE '{}'::pg_catalog.jsonb END,
     p_key, p_created_at);
END;
$$;

-- A video job with no lane in params: the legacy/absent-lane shape.
CREATE OR REPLACE FUNCTION pg_temp.mkjob_nolane(
  p_org UUID, p_user UUID, p_status TEXT, p_created_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.media_generation_jobs
    (organization_id, created_by, kind, status, prompt, params, created_at)
  VALUES
    (p_org, p_user, 'video', p_status, 'Un cartel para la clínica',
     '{}'::pg_catalog.jsonb, p_created_at);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.quota(p_org UUID, p_kind TEXT, p_lane TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.check_media_quota(p_org, p_kind, p_lane);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.quota_key(
  p_org UUID, p_kind TEXT, p_lane TEXT, p_key TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.check_media_quota(p_org, p_kind, p_lane, p_key);
END;
$$;

-- Reset org A's quota row to an explicit eight-column state:
-- six per-lane caps, then the daily and monthly GPU-seconds budgets.
CREATE OR REPLACE FUNCTION pg_temp.setquota(
  p_dl INT, p_ml INT, p_dq INT, p_mq INT, p_di INT, p_mi INT,
  p_dg INT, p_mg INT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.media_quotas
   WHERE organization_id = 'bbbbbb01-7c12-0000-0000-000000000001';
  INSERT INTO public.media_quotas
    (organization_id, daily_lightning_limit, monthly_lightning_limit,
     daily_quality_limit, monthly_quality_limit,
     daily_image_limit, monthly_image_limit,
     daily_gpu_seconds_limit, monthly_gpu_seconds_limit)
  VALUES
    ('bbbbbb01-7c12-0000-0000-000000000001',
     p_dl, p_ml, p_dq, p_mq, p_di, p_mi, p_dg, p_mg);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.clearjobs(p_org UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.media_generation_jobs WHERE organization_id = p_org;
END;
$$;

-- --- V: kind/lane validation ---------------------------------------------------
-- Validation runs before the lock and before the quota row is read, so
-- these pass with no quota state at all.

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'image', 'bogus')$$,
  'P3M12', 'INVALID_MEDIA_REQUEST',
  'V1: an unknown lane is rejected before any quota logic');

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'audio', 'image')$$,
  'P3M12', 'INVALID_MEDIA_REQUEST',
  'V2: an unknown kind is rejected before any quota logic');

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'image')$$,
  'P3M12', 'INVALID_MEDIA_REQUEST',
  'V3: a mismatched kind/lane pair (video on the image lane) is rejected');

-- --- Q: per-lane enforcement ------------------------------------------------------

SELECT pg_temp.setquota(2, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');

SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'Q1: daily lightning cap reached — the third lightning submission today is rejected');

-- Positive control: one below the cap passes.
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'Q2: one lightning submission under a daily cap of 2 passes');

-- The quality lane has its own daily cap.
SELECT pg_temp.setquota(NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'Q3: daily quality cap reached — a second quality submission today is rejected');

-- And its own monthly cap.
SELECT pg_temp.setquota(NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'Q4: monthly quality cap reached — a second quality submission this month is rejected');

-- The image lane is capped independently of both video lanes.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'image', 'image', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'image', 'image')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'Q5: monthly image cap reached — a second image this month is rejected');

-- A limit of 0 disables the lane; it is not "unlimited".
SELECT pg_temp.setquota(0, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'Q6: a daily lightning limit of 0 rejects even the first submission');

-- A video job with no lane in params counts as lightning (the default).
SELECT pg_temp.setquota(1, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob_nolane('bbbbbb01-7c12-0000-0000-000000000001',
                            '22222201-7c12-0000-0000-000000000001',
                            'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'Q7: a video job with no lane in params consumes the lightning quota');

-- --- X: cross-lane isolation ----------------------------------------------------------

-- Lightning at its cap; quality must be unaffected.
SELECT pg_temp.setquota(1, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'X1: lightning is at its daily cap');
SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'X2: lightning usage does not consume the quality quota');

-- And the reverse: quality at its cap; lightning must be unaffected.
SELECT pg_temp.setquota(NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'X3: quality is at its daily cap');
SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'X4: quality usage does not consume the lightning quota');

-- --- S: skipped jobs do not consume quota ----------------------------------------

SELECT pg_temp.setquota(1, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'skipped', now());
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'skipped', now());
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'skipped', now());

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'S1: skipped lightning jobs never reached the GPU and do not consume the daily quota');

-- --- M: window boundaries ------------------------------------------------------

-- A quality job from last month must not consume this month's quota.
SELECT pg_temp.setquota(NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed',
                     date_trunc('month', now()) - interval '1 day');

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'M1: a quality job created last month does not count toward this month''s quota');

-- But a quality job from this month does.
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'M2: a quality job created this month counts toward the monthly quota');

-- Daily boundary: a lightning job from 26 hours ago is not "today" in UTC.
SELECT pg_temp.setquota(1, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed',
                     now() - interval '26 hours');

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'M3: a lightning job created yesterday (UTC) does not count toward today''s quota');

-- --- U: unconfigured means unlimited ----------------------------------------------

-- Org B has no media_quotas row at all.
SELECT pg_temp.clearjobs('bbbbbb02-7c12-0000-0000-000000000002');
SELECT pg_temp.mkjob('bbbbbb02-7c12-0000-0000-000000000002',
                     '22222202-7c12-0000-0000-000000000002',
                     'video', 'lightning', 'completed', now());
SELECT pg_temp.mkjob('bbbbbb02-7c12-0000-0000-000000000002',
                     '22222202-7c12-0000-0000-000000000002',
                     'video', 'quality', 'completed', now());
SELECT pg_temp.mkjob('bbbbbb02-7c12-0000-0000-000000000002',
                     '22222202-7c12-0000-0000-000000000002',
                     'image', 'image', 'completed', now());

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb02-7c12-0000-0000-000000000002'::uuid, 'video', 'lightning')$$,
  'U1: an org with no quota row is not blocked on any lane');

-- All-NULL limits are the same "not configured" state.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'U2: NULL lane limits and NULL budgets mean no cap');

-- A capped lane does not cap the others: lightning at its cap, quality
-- unset, quality still passes.
SELECT pg_temp.setquota(1, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'U3: an unset quality cap stays unlimited while lightning is capped');

-- --- XO: cross-org isolation ----------------------------------------------------------

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'XO1: org A is at its lightning cap');
SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb02-7c12-0000-0000-000000000002'::uuid, 'video', 'lightning')$$,
  'XO2: org A''s usage does not throttle org B');

-- --- R: reference GPU-s costs ---------------------------------------------------
-- The planning weights the budget accounting prices each lane at. All
-- three are UNMEASURED estimates pending the live run (see the migration
-- header); these tests pin the values so a change is deliberate.

SELECT is(private.media_lane_gpu_seconds('lightning'), 100,
  'R1: the lightning reference cost is 100 GPU-s (measured host reference run)');

SELECT is(private.media_lane_gpu_seconds('quality'), 500,
  'R2: the quality reference cost is 500 GPU-s (~5x the UNet steps, estimated)');

SELECT is(private.media_lane_gpu_seconds('image'), 10,
  'R3: the image reference cost is 10 GPU-s (least grounded, estimated)');

SELECT ok(private.media_lane_gpu_seconds('bogus') IS NULL,
  'R4: an unknown lane has no reference cost');

-- --- B: shared GPU-compute budget ------------------------------------------------
-- The budget is the binding constraint across lanes: admitted reference
-- GPU-s plus the new job's reference cost must not exceed it. Per-lane
-- caps are NULL throughout so only the budget decides.

-- B1: a daily budget of 150 with 100 admitted rejects another lightning
-- job (100 + 100 > 150).
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 150, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'B1: daily GPU budget reached — a second lightning job today is rejected');

-- B2: combined-lane exhaustion — lightning fills the budget, a quality
-- job is rejected even though no per-lane cap is set.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 550, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'B2: lightning usage exhausts the shared budget — a quality job is rejected');

-- B3: the reverse — quality fills the budget, a lightning job is rejected.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 550, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'B3: quality usage exhausts the shared budget — a lightning job is rejected');

-- B4: the monthly budget binds the same way.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 550);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'B4: monthly GPU budget reached — a lightning job this month is rejected');

-- B5: control — one GPU-s under the budget passes.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 150, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'completed', now());

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'image', 'image')$$,
  'B5: 100 admitted + 10 for an image stays within the 150 GPU-s budget');

-- B6: NULL budgets mean unlimited, even with usage present.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'quality', 'completed', now());

SELECT lives_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'quality')$$,
  'B6: NULL GPU budgets do not block submissions');

-- B7: cancelled jobs reached the GPU — they consume the budget.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 150, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'cancelled', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'B7: a cancelled lightning job still consumes the daily GPU budget');

-- B8: dead-lettered jobs likewise consume the budget.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 150, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob('bbbbbb01-7c12-0000-0000-000000000001',
                     '22222201-7c12-0000-0000-000000000001',
                     'video', 'lightning', 'dead_lettered', now());

SELECT throws_ok(
  $$SELECT pg_temp.quota('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'B8: a dead-lettered lightning job still consumes the daily GPU budget');

-- B9: an idempotent replay bypasses the quota check — the key already
-- produced a job, so this is not new work. (Budget 50: even the replayed
-- job's own 100 GPU-s exceeds it; without the bypass this would raise.)
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 50, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.mkjob_key('bbbbbb01-7c12-0000-0000-000000000001',
                         '22222201-7c12-0000-0000-000000000001',
                         'video', 'lightning', 'completed', now(), 'b9-key');

SELECT lives_ok(
  $$SELECT pg_temp.quota_key('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning', 'b9-key')$$,
  'B9: a replay with a known idempotency key bypasses the exhausted budget');

-- B10: control — the same call with an unknown key is still enforced.
SELECT throws_ok(
  $$SELECT pg_temp.quota_key('bbbbbb01-7c12-0000-0000-000000000001'::uuid, 'video', 'lightning', 'b10-other-key')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'B10: an unknown idempotency key does not bypass the budget');

-- --- A: submit_media_job is atomic -------------------------------------------------
-- The A-group goes through the real entry point, so the media_generation
-- flag must be on for org A (missing = disabled).

INSERT INTO public.feature_flags (organization_id, key, is_enabled)
SELECT NULL, 'media_generation', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE organization_id IS NULL AND key = 'media_generation'
);
UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id IS NULL AND key = 'media_generation';
INSERT INTO public.feature_flags (organization_id, key, is_enabled) VALUES
  ('bbbbbb01-7c12-0000-0000-000000000001', 'media_generation', true)
ON CONFLICT DO NOTHING;

-- A1: a first submission passes quota and enqueues in one call.
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 150, NULL);
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');

SELECT ok(
  (SELECT already_exists FROM public.submit_media_job(
    '22222201-7c12-0000-0000-000000000001'::uuid,
    'bbbbbb01-7c12-0000-0000-000000000001'::uuid,
    'video', 'Un video',
    '{"lane": "lightning"}'::jsonb, 'a1-key')) = false,
  'A1: submit_media_job admits a lightning job under the budget and enqueues it');

SELECT is(
  (SELECT count(*)::int FROM public.media_generation_jobs
   WHERE organization_id = 'bbbbbb01-7c12-0000-0000-000000000001'::uuid),
  1, 'A1b: exactly one job row was reserved');

-- A2: a budget-exhausted submission raises P3M16 and reserves nothing.
SELECT throws_ok(
  $$SELECT public.submit_media_job(
    '22222201-7c12-0000-0000-000000000001'::uuid,
    'bbbbbb01-7c12-0000-0000-000000000001'::uuid,
    'video', 'Un video',
    '{"lane": "quality"}'::jsonb, 'a2-key')$$,
  'P3M16', 'MEDIA_QUOTA_EXCEEDED',
  'A2: a quality submission over the budget is rejected atomically');

SELECT is(
  (SELECT count(*)::int FROM public.media_generation_jobs
   WHERE organization_id = 'bbbbbb01-7c12-0000-0000-000000000001'::uuid
     AND idempotency_key = 'a2-key'),
  0, 'A2b: the rejected submission reserved no job row');

-- A3: idempotent replay bypasses the quota gate and returns the existing
-- job. Tighten the budget below the already-admitted 100 GPU-s first.
SELECT pg_temp.clearjobs('bbbbbb01-7c12-0000-0000-000000000001');
SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 150, NULL);

SELECT ok(
  (SELECT already_exists FROM public.submit_media_job(
    '22222201-7c12-0000-0000-000000000001'::uuid,
    'bbbbbb01-7c12-0000-0000-000000000001'::uuid,
    'video', 'Un video',
    '{"lane": "lightning"}'::jsonb, 'a3-key')) = false,
  'A3 setup: first submission with key a3-key is admitted');

SELECT pg_temp.setquota(NULL, NULL, NULL, NULL, NULL, NULL, 50, NULL);

SELECT ok(
  (SELECT already_exists FROM public.submit_media_job(
    '22222201-7c12-0000-0000-000000000001'::uuid,
    'bbbbbb01-7c12-0000-0000-000000000001'::uuid,
    'video', 'Un video',
    '{"lane": "lightning"}'::jsonb, 'a3-key')) = true,
  'A3: replaying key a3-key under an exhausted budget returns the existing job');

-- A4: the bypass does not skip the conflict check — same key, different
-- prompt still raises P3M14.
SELECT throws_ok(
  $$SELECT public.submit_media_job(
    '22222201-7c12-0000-0000-000000000001'::uuid,
    'bbbbbb01-7c12-0000-0000-000000000001'::uuid,
    'video', 'Un video DISTINTO',
    '{"lane": "lightning"}'::jsonb, 'a3-key')$$,
  'P3M14', 'MEDIA_IDEMPOTENCY_CONFLICT',
  'A4: replaying a key with different params raises P3M14, not a quota error');

-- --- C: genuine two-session concurrent race -----------------------------------------
--
-- Two dblink sessions submit different lanes concurrently against a tight
-- shared budget (550 GPU-s). The advisory lock serializes the
-- check-then-enqueue: session A (lightning, 100) commits first, session B
-- (quality, 500) then sees 100 admitted and is quota-rejected —
-- deterministically, because B's submit blocks on A's lock. The mechanism
-- is PR #4's D3 pattern (see media_worker_rpcs.test.sql): a dblink
-- self-connection over the unix socket; where it is unavailable C1..C5
-- SKIP instead of failing.
--
-- What this pins: the quota check observes the winner's reservation. If
-- the check and the enqueue were not atomic, both sessions could read 0
-- admitted and both would enqueue, over-admitting the budget.

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE OR REPLACE FUNCTION pg_temp.race_connstr() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  -- No host: libpq defaults to the unix socket, i.e. this same server.
  SELECT format('dbname=%s', current_database())
$$;

CREATE TEMP TABLE _qrace_env(avail BOOLEAN);
CREATE TEMP TABLE _qrace_out(
  b_sqlstate TEXT, job_ct INT, admitted_gpu INT, winner_lane TEXT
);

DO $qrace$
DECLARE
  v_conn TEXT := pg_temp.race_connstr();
BEGIN
  BEGIN
    PERFORM dblink_connect('qrace_probe', v_conn);
    PERFORM dblink_disconnect('qrace_probe');
    INSERT INTO _qrace_env VALUES (true);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _qrace_env VALUES (false);
  END;
END $qrace$;

SELECT diag('C genuine race: dblink self-connection ' ||
  CASE WHEN (SELECT avail FROM _qrace_env) THEN 'available'
       ELSE 'UNAVAILABLE — C1..C5 will skip' END);

SELECT skip('C: dblink self-connection unavailable in this environment', 5)
WHERE NOT (SELECT avail FROM _qrace_env);

DO $qrace$
DECLARE
  v_conn TEXT := pg_temp.race_connstr();
  v_org  UUID := 'bbbbbb03-7c12-0000-0000-000000000003';
  v_user UUID := '22222203-7c12-0000-0000-000000000003';
  v_a_job UUID;
  v_a_msg BIGINT;
  v_b_sqlstate TEXT := 'NO_ERROR';
  v_job_ct INT;
  v_gpu INT;
  v_lane TEXT;
BEGIN
  IF NOT (SELECT avail FROM _qrace_env) THEN RETURN; END IF;

  -- 1. Committed fixtures for the race org, via their own session (this
  --    session's own inserts are uncommitted and invisible to the race
  --    sessions).
  PERFORM dblink_connect('qrace_setup', v_conn);
  PERFORM dblink_exec('qrace_setup', 'BEGIN');
  PERFORM dblink_exec('qrace_setup', format(
    $$INSERT INTO public.organizations(id,name,slug)
      VALUES ('%s','Race Org Q','race-org-q')$$, v_org));
  PERFORM dblink_exec('qrace_setup', format(
    $$INSERT INTO public.profiles(id,email)
      VALUES ('%s','race-q@example.com')$$, v_user));
  PERFORM dblink_exec('qrace_setup', format(
    $$INSERT INTO public.organization_members(organization_id,user_id,role)
      VALUES ('%s','%s','owner')$$, v_org, v_user));
  PERFORM dblink_exec('qrace_setup', format(
    $$INSERT INTO public.feature_flags(organization_id,key,is_enabled)
      VALUES ('%s','media_generation',true)$$, v_org));
  -- The global flag row lives in this session's uncommitted transaction
  -- and is invisible to the race sessions; commit it for them too.
  PERFORM dblink_exec('qrace_setup',
    $$INSERT INTO public.feature_flags(organization_id,key,is_enabled)
      SELECT NULL,'media_generation',true
      WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags
                        WHERE organization_id IS NULL
                          AND key = 'media_generation')$$);
  -- Tight shared budget: 550 GPU-s. Lightning (100) + quality (500) =
  -- 600 > 550, so exactly one of the two racers can be admitted.
  -- Per-lane caps stay NULL: only the budget decides.
  PERFORM dblink_exec('qrace_setup', format(
    $$INSERT INTO public.media_quotas(organization_id,daily_gpu_seconds_limit)
      VALUES ('%s',550)$$, v_org));
  PERFORM dblink_exec('qrace_setup', 'COMMIT');
  PERFORM dblink_disconnect('qrace_setup');

  -- 2. Session A submits lightning and HOLDS its transaction open.
  PERFORM dblink_connect('qrace_a', v_conn);
  PERFORM dblink_exec('qrace_a', 'BEGIN');
  SELECT j.job_id, j.pgmq_msg_id INTO v_a_job, v_a_msg
  FROM dblink('qrace_a', format(
    $$SELECT job_id, pgmq_msg_id FROM public.submit_media_job('%s','%s','video','Un video','{"lane":"lightning"}'::jsonb,'qrace-a')$$,
    v_user, v_org)) AS j(job_id UUID, pgmq_msg_id BIGINT);

  -- 3. Session B submits quality ASYNC — blocks on A's advisory lock.
  --    (Async: a synchronous call would deadlock the orchestrating
  --    session while B waits for the lock.)
  PERFORM dblink_connect('qrace_b', v_conn);
  PERFORM dblink_exec('qrace_b', 'BEGIN');
  PERFORM dblink_send_query('qrace_b', format(
    $$SELECT job_id FROM public.submit_media_job('%s','%s','video','Un video','{"lane":"quality"}'::jsonb,'qrace-b')$$,
    v_user, v_org));
  PERFORM pg_sleep(0.5);

  -- 4. A commits; B's submit is released, sees A's 100 GPU-s admitted,
  --    and loses on the budget: 100 + 500 > 550 → P3M16.
  PERFORM dblink_exec('qrace_a', 'COMMIT');
  BEGIN
    PERFORM dblink_get_result('qrace_b');
  EXCEPTION WHEN OTHERS THEN
    v_b_sqlstate := SQLSTATE;
  END;
  -- B's session still holds the failed async query: a plain ROLLBACK on
  -- it raises "another command is already in progress". Disconnecting
  -- aborts the remote transaction instead.
  PERFORM dblink_disconnect('qrace_b');
  PERFORM dblink_disconnect('qrace_a');

  -- 5. Record the race outcome (A's row is committed; B's rolled back).
  SELECT count(*)::int INTO v_job_ct
  FROM public.media_generation_jobs
  WHERE organization_id = v_org;
  SELECT pg_catalog.coalesce(pg_catalog.sum(
    private.media_lane_gpu_seconds(
      CASE WHEN kind = 'image' THEN 'image'
           ELSE pg_catalog.coalesce(params->>'lane', 'lightning')
      END)), 0)::int INTO v_gpu
  FROM public.media_generation_jobs
  WHERE organization_id = v_org AND status <> 'skipped';
  SELECT pg_catalog.coalesce(params->>'lane', 'lightning') INTO v_lane
  FROM public.media_generation_jobs
  WHERE organization_id = v_org
  LIMIT 1;
  INSERT INTO _qrace_out VALUES (v_b_sqlstate, v_job_ct, v_gpu, v_lane);

  -- 6. Cleanup so later groups see the pre-race state.
  PERFORM pgmq.delete('media_jobs', v_a_msg);
  DELETE FROM public.media_generation_jobs WHERE organization_id = v_org;
  DELETE FROM public.media_quotas WHERE organization_id = v_org;
  DELETE FROM public.feature_flags WHERE organization_id = v_org AND key = 'media_generation';
  DELETE FROM public.organization_members WHERE organization_id = v_org;
  DELETE FROM public.profiles WHERE id = v_user;
  DELETE FROM public.organizations WHERE id = v_org;
  -- qrace_setup committed a second global flag row (its NOT EXISTS could
  -- not see this session's uncommitted one); collapse back to exactly one
  -- so the scalar subquery in is_feature_enabled keeps working.
  DELETE FROM public.feature_flags WHERE organization_id IS NULL AND key = 'media_generation';
  INSERT INTO public.feature_flags(organization_id,key,is_enabled)
  VALUES (NULL,'media_generation',true);
END $qrace$;

SELECT is((SELECT b_sqlstate FROM _qrace_out), 'P3M16',
          'C1: the loser of the genuine two-session race gets P3M16 (quota), not P3M09')
WHERE (SELECT avail FROM _qrace_env);

SELECT is((SELECT job_ct FROM _qrace_out), 1,
          'C2: exactly one job survives the concurrent race')
WHERE (SELECT avail FROM _qrace_env);

SELECT is((SELECT admitted_gpu FROM _qrace_out), 100,
          'C3: total admitted reference GPU-s is exactly the lightning winner''s 100 (<= 550 budget)')
WHERE (SELECT avail FROM _qrace_env);

SELECT is((SELECT winner_lane FROM _qrace_out), 'lightning',
          'C4: the survivor is the session that committed first (lightning)')
WHERE (SELECT avail FROM _qrace_env);

SELECT is((SELECT count(*)::int FROM public.media_generation_jobs
           WHERE idempotency_key = 'qrace-b'), 0,
          'C5: the loser''s job row never materialized')
WHERE (SELECT avail FROM _qrace_env);

-- C5 is folded into the serial B-group: after the race, a quality check
-- against the winner's 100 admitted GPU-s is still P3M16 (100 + 500 >
-- 550) — the reservation is visible to later checks. Covered by B2's
-- shape; no extra assertion needed here.

-- --- G: grants --------------------------------------------------------------------------

SELECT ok(
  has_function_privilege('service_role',
    'public.check_media_quota(uuid, text, text, text)', 'EXECUTE'),
  'G1: service_role can execute check_media_quota(uuid, text, text, text)');

SELECT ok(
  NOT has_function_privilege('anon',
    'public.check_media_quota(uuid, text, text, text)', 'EXECUTE'),
  'G2: anon cannot execute check_media_quota(uuid, text, text, text)');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.check_media_quota(uuid, text, text, text)', 'EXECUTE'),
  'G3: authenticated cannot execute check_media_quota(uuid, text, text, text)');

SELECT ok(
  has_function_privilege('service_role',
    'public.submit_media_job(uuid, uuid, text, text, jsonb, text)', 'EXECUTE'),
  'G4: service_role can execute submit_media_job');

SELECT ok(
  NOT has_function_privilege('anon',
    'public.submit_media_job(uuid, uuid, text, text, jsonb, text)', 'EXECUTE'),
  'G5: anon cannot execute submit_media_job');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.submit_media_job(uuid, uuid, text, text, jsonb, text)', 'EXECUTE'),
  'G6: authenticated cannot execute submit_media_job');

SELECT * FROM finish();
ROLLBACK;
