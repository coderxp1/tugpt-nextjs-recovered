-- org_usage_summary.test.sql
--
-- Analytics v1 read path (20260911000001). Four claims carry the file, and
-- they are the four ways a usage report is normally wrong.
--
-- THE AGGREGATE IS THE ONLY READ PATH (G1-G6). The usage tables stay
-- service_role-only; `authenticated` gets EXECUTE on the public wrapper and
-- nothing else. G6 is the positive control in the negative direction: a
-- direct SELECT on the events table as `authenticated` must still be refused,
-- or every aggregate assertion above it is decoration on an open door.
--
-- MEMBERSHIP IS THE AUTHORIZATION, WITH ONE ANSWER (M1-M4). A member reads
-- their own organization; an outsider gets the SAME error as a nonexistent
-- organization id, so the function is not an existence oracle; a caller with
-- no auth claims at all is refused before membership is even asked.
--
-- THE WINDOW MEANS WHAT IT SAYS (W1-W3). `p_from` inclusive, `p_to`
-- exclusive; an event outside the window is absent from every total, not
-- just from a count; an unordered or absurd window is refused rather than
-- quietly widened.
--
-- UNKNOWN IS NEVER ZERO (U1-U5). The contract 20260903000002 was written
-- around: an unpriced call is counted and its quantity is still summed, but
-- it contributes nothing to any cost total; a cost in a currency with no fx
-- rate is counted as unconverted rather than summed as if it were. A report
-- that valued either at zero would understate exactly the spend nobody has
-- priced yet — the spend most worth looking at.
--
-- ISOLATION (I1-I2). Another organization's events exist in the same table
-- at the same time and appear in no total of the first organization's
-- summary.

BEGIN;
SELECT plan(22);

-- --- Fixtures ---------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-c057-0000-0000-00000000a001', 'member@espiga.test'),
  ('11111111-c057-0000-0000-00000000a002', 'outsider@otra.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-c057-0000-0000-0000000000a1', 'Panadería La Espiga', 'espiga-usage-test'),
  ('aaaaaaaa-c057-0000-0000-0000000000a2', 'Otra Organización',   'otra-usage-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-c057-0000-0000-0000000000a1', '11111111-c057-0000-0000-00000000a001', 'owner'),
  ('aaaaaaaa-c057-0000-0000-0000000000a2', '11111111-c057-0000-0000-00000000a002', 'owner');

-- Rates chosen to make the arithmetic checkable by eye: 10 µUSD per input
-- token, 30 µUSD per output token.
INSERT INTO public.provider_prices
  (provider, model, dimension, unit_price, source, effective_from)
VALUES
  ('testprov', 'test-model', 'input_tokens',  0.0000100000,
   'fixture: round number, arithmetic checkable by eye', '2020-01-01'),
  ('testprov', 'test-model', 'output_tokens', 0.0000300000,
   'fixture: three times the input rate, so a swap is visible', '2020-01-01');

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
END; $$;

-- Events, through the recording function rather than raw INSERTs: the summary
-- must be right about the rows the workers actually produce, including the
-- deferred total trigger and the currency pairing constraint.
--
--   e1  org A, text, PRICED   — 1000 in + 500 out = 10000 + 15000 = 25000 µUSD
--   e2  org A, audio, UNPRICED — 'noprice' has no rate; 120 billed seconds
--   e3  org A, text, PRICED   — 40 days old: outside a 30-day window
--   e4  org B, text, PRICED   — same instant as e1, different tenant
SELECT private.record_provider_usage(
  'aaaaaaaa-c057-0000-0000-0000000000a1', 'text', 'testprov', 'test-model',
  '{"input_tokens": 1000, "output_tokens": 500}'::jsonb,
  'prov-ref-u1', 'req-u1', NULL, NULL, '{}'::jsonb, now() - INTERVAL '2 days');

SELECT private.record_provider_usage(
  'aaaaaaaa-c057-0000-0000-0000000000a1', 'audio', 'noprice', 'nomodel',
  '{"audio_seconds": 120}'::jsonb,
  'prov-ref-u2', 'req-u2', NULL, NULL, '{}'::jsonb, now() - INTERVAL '2 days');

SELECT private.record_provider_usage(
  'aaaaaaaa-c057-0000-0000-0000000000a1', 'text', 'testprov', 'test-model',
  '{"input_tokens": 10, "output_tokens": 10}'::jsonb,
  'prov-ref-u3', 'req-u3', NULL, NULL, '{}'::jsonb, now() - INTERVAL '40 days');

SELECT private.record_provider_usage(
  'aaaaaaaa-c057-0000-0000-0000000000a2', 'text', 'testprov', 'test-model',
  '{"input_tokens": 7, "output_tokens": 7}'::jsonb,
  'prov-ref-u4', 'req-u4', NULL, NULL, '{}'::jsonb, now() - INTERVAL '2 days');

-- --- G: the aggregate is the only read path ----------------------------------

SELECT has_function('public', 'org_usage_summary',
  ARRAY['uuid', 'timestamp with time zone', 'timestamp with time zone'],
  'G1: public.org_usage_summary(uuid, timestamptz, timestamptz) exists');

SELECT has_function('private', 'org_usage_summary',
  ARRAY['uuid', 'timestamp with time zone', 'timestamp with time zone'],
  'G2: the work happens in the private schema');

SELECT is(
  (SELECT security_type FROM information_schema.routines
   WHERE routine_schema = 'public' AND routine_name = 'org_usage_summary'),
  'DEFINER',
  'G3: the public wrapper is SECURITY DEFINER');

SELECT ok(
  (SELECT bool_or(
     p.proconfig IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM unnest(p.proconfig) AS cfg
       WHERE cfg LIKE 'search_path=%' AND cfg LIKE '%pg_temp'
     )
   )
   FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'org_usage_summary'),
  'G4: the wrapper pins its search_path and ends it at pg_temp, so a caller '
  'cannot shadow the schemas it reads through');

SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public' AND routine_name = 'org_usage_summary'
     AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'),
  1,
  'G5: authenticated may EXECUTE the public wrapper');

-- The positive control in the negative direction. Every aggregate assertion
-- below is worthless if the rows themselves are readable, and this is the
-- assertion that says the door is still closed.
SELECT pg_temp.act_as('11111111-c057-0000-0000-00000000a001');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT count(*) FROM public.provider_usage_events$$,
  '42501',
  NULL,
  'G6: a member still cannot SELECT the events table directly — the summary '
  'is the read path, not a convenience over one');

SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'private' AND routine_name = 'org_usage_summary'
     AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'),
  0,
  'G7: the private schema stays unexposed to authenticated');

SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public' AND routine_name = 'org_usage_summary'
     AND grantee = 'anon' AND privilege_type = 'EXECUTE'),
  0,
  'G8: anon has no EXECUTE — no session, no membership, no aggregate');

-- --- M: membership is the authorization --------------------------------------

-- M1 runs as the member (role still authenticated, claims still set).
SELECT is(
  (public.org_usage_summary(
     'aaaaaaaa-c057-0000-0000-0000000000a1',
     now() - INTERVAL '30 days', now())
   ->'totals'->>'events')::int,
  2,
  'M1: a member reads their own organization (e1 + e2 in window, e3 out)');

SET LOCAL ROLE postgres;

-- M2: the outsider gets P3J02 for an organization that EXISTS. M3: the same
-- error for one that does not. Compared side by side, they are the point —
-- one answer, no oracle.
SELECT pg_temp.act_as('11111111-c057-0000-0000-00000000a002');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.org_usage_summary(
      'aaaaaaaa-c057-0000-0000-0000000000a1',
      now() - INTERVAL '30 days', now())$$,
  'P3J02',
  NULL,
  'M2: a non-member asking for a real organization is refused');

SELECT throws_ok(
  $$SELECT public.org_usage_summary(
      'dddddddd-0000-0000-0000-000000000000',
      now() - INTERVAL '30 days', now())$$,
  'P3J02',
  NULL,
  'M3: ...with the SAME error as a nonexistent id, so the refusal cannot be '
  'used to enumerate organizations');

SET LOCAL ROLE postgres;
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.org_usage_summary(
      'aaaaaaaa-c057-0000-0000-0000000000a1',
      now() - INTERVAL '30 days', now())$$,
  'P3J01',
  NULL,
  'M4: a caller with no auth claims is refused before membership is asked');

-- --- W: the window means what it says ----------------------------------------

SET LOCAL ROLE postgres;
SELECT pg_temp.act_as('11111111-c057-0000-0000-00000000a001');
SET LOCAL ROLE authenticated;

SELECT is(
  (public.org_usage_summary(
     'aaaaaaaa-c057-0000-0000-0000000000a1',
     now() - INTERVAL '60 days', now())
   ->'totals'->>'events')::int,
  3,
  'W1: widening the window admits the 40-day-old event');

SELECT throws_ok(
  $$SELECT public.org_usage_summary(
      'aaaaaaaa-c057-0000-0000-0000000000a1', now(), now() - INTERVAL '1 day')$$,
  'P3J03',
  NULL,
  'W2: an inverted window is refused, not silently reordered');

SELECT throws_ok(
  $$SELECT public.org_usage_summary(
      'aaaaaaaa-c057-0000-0000-0000000000a1',
      now() - INTERVAL '400 days', now())$$,
  'P3J04',
  NULL,
  'W3: an absurd window is refused rather than scanned');

-- --- U: unknown is never zero -------------------------------------------------

SELECT is(
  (public.org_usage_summary(
     'aaaaaaaa-c057-0000-0000-0000000000a1',
     now() - INTERVAL '30 days', now())
   ->'totals'->>'unpriced_events')::int,
  1,
  'U1: the unpriced call is COUNTED...');

SELECT is(
  (SELECT sum((c->>'cost_micros')::bigint)
   FROM jsonb_array_elements(
     public.org_usage_summary(
       'aaaaaaaa-c057-0000-0000-0000000000a1',
       now() - INTERVAL '30 days', now())
     ->'totals'->'costs_by_currency') c),
  25000::bigint,
  'U2: ...and contributes nothing to the cost total: 25000 µUSD is the '
  'priced event alone, not 25000 plus a zero for the unpriced one');

SELECT is(
  (public.org_usage_summary(
     'aaaaaaaa-c057-0000-0000-0000000000a1',
     now() - INTERVAL '30 days', now())
   ->'totals'->'quantities'->>'audio_seconds')::bigint,
  120::bigint,
  'U3: the unpriced call''s QUANTITY is still summed — unknown price is not '
  'unknown consumption');

SELECT is(
  (public.org_usage_summary(
     'aaaaaaaa-c057-0000-0000-0000000000a1',
     now() - INTERVAL '30 days', now())
   ->'totals'->>'accounting_cost_micros')::bigint,
  25000::bigint,
  'U4: USD spend accounts 1:1 in the USD accounting currency (identity fx, '
  'no rate row needed)');

SELECT is(
  (SELECT count(*)::int
   FROM jsonb_array_elements(
     public.org_usage_summary(
       'aaaaaaaa-c057-0000-0000-0000000000a1',
       now() - INTERVAL '30 days', now())
     ->'by_provider') g
   WHERE g->>'provider' = 'noprice'
     AND (g->>'unpriced_events')::int = 1
     AND jsonb_array_length(g->'costs') = 0),
  1,
  'U5: the per-provider row for the unpriced call shows the count and an '
  'EMPTY cost list — never a fabricated 0.00');

-- --- I: isolation --------------------------------------------------------------

SELECT is(
  (public.org_usage_summary(
     'aaaaaaaa-c057-0000-0000-0000000000a1',
     now() - INTERVAL '30 days', now())
   ->'totals'->'quantities'->>'input_tokens')::bigint,
  1000::bigint,
  'I1: org B''s event at the same instant moves none of org A''s totals');

SELECT ok(
  jsonb_typeof(
    public.org_usage_summary(
      'aaaaaaaa-c057-0000-0000-0000000000a1',
      now() - INTERVAL '30 days', now())
    ->'totals'->'costs_by_currency') = 'array',
  'I2: costs_by_currency is an array even for a single currency — the shape '
  'a multi-currency month will arrive in, already on the wire');

SELECT finish();
ROLLBACK;
