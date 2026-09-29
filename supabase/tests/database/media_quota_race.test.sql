-- media_quota_race.test.sql — C: genuine two-session quota race.
--
-- Two sessions submit different lanes concurrently against a tight shared
-- budget (550 GPU-s). The advisory lock serializes the check-then-enqueue:
-- session A (lightning, 100) commits first, session B (quality, 500) then
-- sees 100 admitted and is quota-rejected — deterministically, because B's
-- submit blocks on A's lock.
--
-- What this pins: the quota check observes the winner's reservation. If
-- the check and the enqueue were not atomic, both sessions could read 0
-- admitted and both would enqueue, over-admitting the budget.
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
--     supabase/tests/database/media_concurrency_race.test.sql \
--     supabase/tests/database/media_quota_race.test.sql
--
-- (port 56322 is config.toml [db].port; supabase_admin is the
-- supabase/postgres superuser whose password the image sets from the db
-- password.) As superuser the dblink security checks are skipped and the
-- unix-socket self-connection just works, so C1..C5 execute as ordinary
-- assertions. If the self-connection fails here anyway, the file FAILS
-- CLOSED (RAISE EXCEPTION) — there is no skip path in this file.
--
-- Under the regular `--local` run this file is still picked up by the
-- recursive scan, so it detects the non-superuser session and emits
-- plan(0) with a diagnostic: a no-op, never a failure, never a skip of a
-- test that claims to have run.

CREATE EXTENSION IF NOT EXISTS dblink;

BEGIN;

CREATE TEMP TABLE _qrace_run(run BOOLEAN);
INSERT INTO _qrace_run SELECT rolsuper FROM pg_roles WHERE rolname = current_user;

SELECT plan((SELECT CASE WHEN run THEN 5 ELSE 0 END FROM _qrace_run));

SELECT diag('C quota race: ' ||
  CASE WHEN (SELECT run FROM _qrace_run)
       THEN 'running as superuser ' || current_user || ' — C1..C5 execute for real'
       ELSE 'non-superuser session — no-op under this invocation (runs in the CI race step)' END);

CREATE TEMP TABLE _qrace_out(
  b_sqlstate TEXT, job_ct INT, admitted_gpu INT, winner_lane TEXT
);

DO $qrace$
DECLARE
  v_conn TEXT := format('dbname=%s', current_database());
  v_org  UUID := 'bbbbbb03-7c12-0000-0000-000000000003';
  v_user UUID := '22222203-7c12-0000-0000-000000000003';
  v_a_job UUID;
  v_a_msg BIGINT;
  v_b_sqlstate TEXT := 'NO_ERROR';
  v_job_ct INT;
  v_gpu INT;
  v_lane TEXT;
BEGIN
  IF NOT (SELECT run FROM _qrace_run) THEN RETURN; END IF;

  -- Fail closed: as superuser the self-connection must work. Any failure
  -- here is a real environment problem, not a reason to skip.
  BEGIN
    PERFORM dblink_connect('qrace_selftest', v_conn);
    PERFORM dblink_disconnect('qrace_selftest');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'C quota race: dblink self-connection failed as superuser %: %',
      current_user, SQLERRM;
  END;

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
  SELECT coalesce(sum(
    private.media_lane_gpu_seconds(
      CASE WHEN kind = 'image' THEN 'image'
           ELSE coalesce(params->>'lane', 'lightning')
      END)), 0)::int INTO v_gpu
  FROM public.media_generation_jobs
  WHERE organization_id = v_org AND status <> 'skipped';
  SELECT coalesce(params->>'lane', 'lightning') INTO v_lane
  FROM public.media_generation_jobs
  WHERE organization_id = v_org
  LIMIT 1;
  INSERT INTO _qrace_out VALUES (v_b_sqlstate, v_job_ct, v_gpu, v_lane);

  -- 6. Cleanup so no other suite sees this file's state.
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
WHERE (SELECT run FROM _qrace_run);

SELECT is((SELECT job_ct FROM _qrace_out), 1,
          'C2: exactly one job survives the concurrent race')
WHERE (SELECT run FROM _qrace_run);

SELECT is((SELECT admitted_gpu FROM _qrace_out), 100,
          'C3: total admitted reference GPU-s is exactly the lightning winner''s 100 (<= 550 budget)')
WHERE (SELECT run FROM _qrace_run);

SELECT is((SELECT winner_lane FROM _qrace_out), 'lightning',
          'C4: the survivor is the session that committed first (lightning)')
WHERE (SELECT run FROM _qrace_run);

SELECT is((SELECT count(*)::int FROM public.media_generation_jobs
           WHERE idempotency_key = 'qrace-b'), 0,
          'C5: the loser''s job row never materialized')
WHERE (SELECT run FROM _qrace_run);

SELECT * FROM finish();
ROLLBACK;
