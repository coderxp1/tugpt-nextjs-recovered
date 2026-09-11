-- Analytics v1: the organization-scoped usage & cost summary.
-- Migration: 20260911000001_org_usage_summary_rpc.sql
--
-- ============================================================================
-- THE GAP THIS CLOSES
-- ============================================================================
--
-- Since 20260903000002 every provider call the draft and transcription
-- workers make is recorded in `provider_usage_events` with its components,
-- its native-currency cost and its accounting-currency conversion. The data
-- foundation is complete and both workers write to it.
--
-- Nobody can read it. The tables are deliberately service_role-only:
--
--   REVOKE ALL ON public.provider_usage_events FROM authenticated, anon;
--
-- and a usage row names a provider, a model and a cost — commercial data that
-- must not be enumerable row by row from a browser key. So the read path is
-- this function: one aggregate, one organization, one window, membership
-- checked inside the definer, and no row-level access granted anywhere.
--
-- ============================================================================
-- WHAT IT RETURNS, AND THE TWO NUMBERS IT REFUSES TO INVENT
-- ============================================================================
--
-- 1. AN UNPRICED CALL IS COUNTED, NOT ZERO. `cost_micros IS NULL` means the
--    price book had no rate — the provider will still bill it. Every total
--    here sums only priced rows, and the unpriced rows are returned as their
--    own count (`unpriced_events`) so the screen can say "cost unknown for
--    N calls" instead of showing a total that silently treats them as free.
--    This is the storage contract of 20260903000002 §4 carried through to
--    the read path.
--
-- 2. AN UNCONVERTED COST IS COUNTED, NOT ZERO. A priced event whose currency
--    had no fx rate at its instant carries `accounting_cost_micros IS NULL`
--    (20260903000006). The accounting total sums only converted rows and
--    reports the remainder as `unconverted_events`; the native-currency
--    totals in `costs_by_currency` are where those costs are still visible.
--
-- Quantities (tokens, billed audio seconds) are summed for ALL events,
-- priced or not: the quantity is known even when the price is not, and
-- "we do not know what it cost" is not "it did not happen".
--
-- ============================================================================
-- AUTHORIZATION POSTURE
-- ============================================================================
--
-- Copied from the invitation functions (20260902000001), because it was
-- reviewed there:
--
--   * No actor  -> P3J01. An anonymous caller has no business here.
--   * Non-member OR nonexistent organization -> the SAME error (P3J02,
--     'Organization not found'). Distinguishing them would let an
--     authenticated stranger enumerate organization ids by watching the
--     error change.
--   * The organization id is an ARGUMENT, validated against membership
--     inside the definer — the same shape `create_invitation` uses. It is
--     never trusted from the caller: the check is the argument's whole
--     purpose.
--   * The window is validated (ordered, bounded) so a caller cannot ask for
--     "everything since 1970" and turn a report into a table scan of every
--     event the organization has ever produced. 366 days covers a leap year
--     of monthly comparisons and nothing legitimate beyond it.
--
-- P3J is a new error family. P3H is secret storage (20260903000003) and P3I
-- is the transcription worker (20260905000001); this is the analytics read
-- path, and it gets its own range for the reason the invitation migration
-- gives: a code is a contract with the screen, and a sentence written for
-- one failure should not arrive attached to another.

CREATE OR REPLACE FUNCTION private.org_usage_summary(
  p_organization_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_result JSONB;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = 'P3J01';
  END IF;

  -- Membership is the authorization. One answer for "not a member" and "no
  -- such organization", so the error cannot be used as an existence oracle.
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = p_organization_id
      AND user_id = v_actor
  ) THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = 'P3J02';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'Invalid time window' USING ERRCODE = 'P3J03';
  END IF;

  IF p_to - p_from > INTERVAL '366 days' THEN
    RAISE EXCEPTION 'Time window too large' USING ERRCODE = 'P3J04';
  END IF;

  WITH e AS (
    SELECT ev.id, ev.provider, ev.model, ev.modality, ev.currency,
           ev.cost_micros, ev.accounting_cost_micros
    FROM public.provider_usage_events ev
    WHERE ev.organization_id = p_organization_id
      AND ev.occurred_at >= p_from
      AND ev.occurred_at <  p_to
  ),
  -- Per-group quantity sums, pivoted into one object per group below.
  gq AS (
    SELECT e.provider, e.model, e.modality, c.dimension,
           sum(c.quantity)::bigint AS qty
    FROM public.provider_usage_components c
    JOIN e ON e.id = c.event_id
    GROUP BY e.provider, e.model, e.modality, c.dimension
  ),
  -- Per-group native-currency cost sums. Priced rows only: the currency of
  -- an unpriced cost is NULL by constraint (20260903000005), and there is
  -- nothing honest to group it under.
  gc AS (
    SELECT e.provider, e.model, e.modality, e.currency,
           sum(e.cost_micros)::bigint AS cost_micros
    FROM e
    WHERE e.cost_micros IS NOT NULL
    GROUP BY e.provider, e.model, e.modality, e.currency
  ),
  g AS (
    SELECT e.provider, e.model, e.modality,
           count(*)::int AS events,
           count(*) FILTER (WHERE e.cost_micros IS NULL)::int AS unpriced_events,
           count(*) FILTER (
             WHERE e.cost_micros IS NOT NULL
               AND e.accounting_cost_micros IS NULL
           )::int AS unconverted_events,
           COALESCE(sum(e.accounting_cost_micros), 0)::bigint
             AS accounting_cost_micros
    FROM e
    GROUP BY e.provider, e.model, e.modality
  ),
  t AS (
    SELECT count(*)::int AS events,
           count(*) FILTER (WHERE cost_micros IS NOT NULL)::int AS priced_events,
           count(*) FILTER (WHERE cost_micros IS NULL)::int AS unpriced_events,
           count(*) FILTER (
             WHERE cost_micros IS NOT NULL
               AND accounting_cost_micros IS NULL
           )::int AS unconverted_events,
           COALESCE(sum(accounting_cost_micros), 0)::bigint
             AS accounting_cost_micros
    FROM e
  ),
  tq AS (
    SELECT COALESCE(jsonb_object_agg(s.dimension, s.qty), '{}'::jsonb) AS quantities
    FROM (
      SELECT c.dimension, sum(c.quantity)::bigint AS qty
      FROM public.provider_usage_components c
      JOIN e ON e.id = c.event_id
      GROUP BY c.dimension
    ) s
  ),
  tc AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('currency', s.currency, 'cost_micros', s.cost_micros)
        ORDER BY s.currency
      ),
      '[]'::jsonb
    ) AS costs_by_currency
    FROM (
      SELECT e.currency, sum(e.cost_micros)::bigint AS cost_micros
      FROM e
      WHERE e.cost_micros IS NOT NULL
      GROUP BY e.currency
    ) s
  )
  SELECT jsonb_build_object(
    'organization_id', p_organization_id,
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'accounting_currency', private.accounting_currency(),
    'totals', (
      SELECT jsonb_build_object(
        'events', t.events,
        'priced_events', t.priced_events,
        'unpriced_events', t.unpriced_events,
        'unconverted_events', t.unconverted_events,
        'accounting_cost_micros', t.accounting_cost_micros,
        'quantities', tq.quantities,
        'costs_by_currency', tc.costs_by_currency
      )
      FROM t, tq, tc
    ),
    'by_provider', (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'provider', g.provider,
            'model', g.model,
            'modality', g.modality,
            'events', g.events,
            'unpriced_events', g.unpriced_events,
            'unconverted_events', g.unconverted_events,
            'accounting_cost_micros', g.accounting_cost_micros,
            'quantities', (
              SELECT COALESCE(jsonb_object_agg(gq.dimension, gq.qty), '{}'::jsonb)
              FROM gq
              WHERE gq.provider = g.provider
                AND gq.model IS NOT DISTINCT FROM g.model
                AND gq.modality = g.modality
            ),
            'costs', (
              SELECT COALESCE(
                jsonb_agg(
                  jsonb_build_object('currency', gc.currency,
                                     'cost_micros', gc.cost_micros)
                  ORDER BY gc.currency
                ),
                '[]'::jsonb
              )
              FROM gc
              WHERE gc.provider = g.provider
                AND gc.model IS NOT DISTINCT FROM g.model
                AND gc.modality = g.modality
            )
          )
          ORDER BY g.events DESC, g.provider ASC,
                   g.model ASC NULLS LAST, g.modality ASC
        ),
        '[]'::jsonb
      )
      FROM g
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION private.org_usage_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Aggregate provider usage and cost for one organization over one window '
  '(p_from inclusive, p_to exclusive, at most 366 days). Membership-checked '
  'against auth.uid(); P3J01 unauthenticated, P3J02 non-member-or-nonexistent '
  '(one answer, so it is not an existence oracle), P3J03 unordered window, '
  'P3J04 window too large. Unpriced events are counted, never valued at '
  'zero; unconverted costs are counted, never summed as if converted.';

-- ---------------------------------------------------------------------------
-- Public wrapper, same shape as the invitation wrappers (20260902000001 §9):
-- the private schema stays unexposed through PostgREST, and the public name
-- is the only thing a client can call.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_usage_summary(
  p_organization_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$ SELECT private.org_usage_summary(p_organization_id, p_from, p_to); $$;

COMMENT ON FUNCTION public.org_usage_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Public wrapper for private.org_usage_summary — analytics v1 read path. '
  'Members only; see the private function for the error contract.';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION private.org_usage_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.org_usage_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;

-- anon has no session and therefore no membership; there is no aggregate an
-- anonymous caller is entitled to.
REVOKE ALL ON FUNCTION public.org_usage_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_usage_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

-- No table grant changes. `provider_usage_events`,
-- `provider_usage_components` and `provider_prices` stay service_role-only;
-- this function is the read path, and it is an aggregate on purpose — a
-- member can see what their organization spent, not walk the underlying
-- rows one by one.
