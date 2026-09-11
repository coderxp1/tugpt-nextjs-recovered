/**
 * @file analytics-usage-route.test.ts
 * @description GET /api/v1/analytics/usage — the analytics v1 read path.
 *
 * The route is thin on purpose: authenticate, resolve the active organization,
 * map `?range=` to a window, call `org_usage_summary` on the USER's client, and
 * hand the aggregate back. These tests hold the thin parts honest, in the order
 * a silent failure would cost:
 *
 *   1. **Auth and tenant.** No user → 401. No active organization → 403, the
 *      same answer whether the caller has no membership or no active selection.
 *   2. **The RPC runs on the user's claims, not an admin client.** The whole
 *      membership check lives inside the definer reading `auth.uid()`; a call on
 *      a service-role client would hollow it out. There is no admin client here
 *      to mock, and this asserts the one that is used is the authenticated one.
 *   3. **The window is bounded and derived server-side.** `?range=` is a preset,
 *      never a free-form date, and the from/to the RPC receives are computed
 *      from the server clock — a caller cannot widen the window from the query.
 *   4. **Errors are mapped, not leaked.** A P3J02 becomes 403 FORBIDDEN; the raw
 *      SQLSTATE and its message never reach the body.
 *   5. **Unknown is not zero.** A summary with unpriced events is passed through
 *      with those counts intact — the route does not fold them into a total.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GET } from './usage/route';

const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: vi.fn(() => Promise.resolve({ rpc: mockRpc })),
}));

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();

vi.mock('@tugpt/auth', () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: mockGetCurrentUser,
      resolveTenantContext: mockResolveTenantContext,
    };
  }),
}));

const ORG_ID = 'aaaaaaaa-c057-0000-0000-0000000000a1';
const USER = { id: 'user-1', email: 'owner@espiga.test' };

/** A summary shape with the fields the route logs and passes through. */
function summary(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG_ID,
    window: { from: '2026-08-12T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z' },
    accounting_currency: 'USD',
    totals: {
      events: 3,
      priced_events: 2,
      unpriced_events: 1,
      unconverted_events: 0,
      accounting_cost_micros: 25000,
      quantities: { input_tokens: 1000, output_tokens: 500, audio_seconds: 120 },
      costs_by_currency: [{ currency: 'USD', cost_micros: 25000 }],
    },
    by_provider: [],
    ...overrides,
  };
}

function setup(opts: { user?: unknown; tenant?: unknown } = {}) {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(
    opts.user !== undefined ? opts.user : USER
  );
  mockResolveTenantContext.mockResolvedValue(
    opts.tenant !== undefined
      ? opts.tenant
      : { organizationId: ORG_ID, organizationName: 'Panadería La Espiga', role: 'owner' }
  );
  mockRpc.mockResolvedValue({ data: summary(), error: null });
}

function request(query = '', tenant: string | null = ORG_ID) {
  const headers: Record<string, string> = {};
  if (tenant) headers['x-tenant-id'] = tenant;
  return new Request(`http://localhost/api/v1/analytics/usage${query}`, { headers });
}

async function call(query = '', tenant: string | null = ORG_ID) {
  const res = await GET(request(query, tenant));
  return { res, body: await res.json() };
}

beforeEach(() => setup());

// --- 1. Auth and tenant -----------------------------------------------------

describe('authentication and tenant resolution', () => {
  it('A1: 401 when there is no user', async () => {
    setup({ user: null });
    const { res, body } = await call();
    expect(res.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('A2: 403 when there is no active organization (no membership OR no selection)', async () => {
    setup({ tenant: null });
    const { res, body } = await call();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('A3: resolves the tenant from the session, passing the requested x-tenant-id', async () => {
    await call();
    expect(mockResolveTenantContext).toHaveBeenCalledWith(USER.id, ORG_ID);
  });
});

// --- 2. The RPC runs on the user's client -----------------------------------

describe('the membership-checked RPC', () => {
  it('R1: calls org_usage_summary with the resolved organization id', async () => {
    await call();
    expect(mockRpc).toHaveBeenCalledWith(
      'org_usage_summary',
      expect.objectContaining({ p_organization_id: ORG_ID })
    );
  });

  it('R2: never sends an organization id taken from the query string', async () => {
    // The tenant comes from the session; a `?organization_id=` is not a thing
    // this route reads. Assert the RPC got the session's org, not an intruder.
    const { res } = await call('?organization_id=dddddddd-0000-0000-0000-000000000000');
    expect(res.status).toBe(200);
    const arg = mockRpc.mock.calls[0][1] as { p_organization_id: string };
    expect(arg.p_organization_id).toBe(ORG_ID);
  });
});

// --- 3. The window is bounded and server-derived ----------------------------

describe('the time window', () => {
  it('W1: defaults to 30d when no range is given', async () => {
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.range).toBe('30d');
  });

  it('W2: accepts each preset and rejects anything else', async () => {
    for (const range of ['7d', '30d', '90d']) {
      setup();
      const { res, body } = await call(`?range=${range}`);
      expect(res.status, `range=${range}`).toBe(200);
      expect(body.range).toBe(range);
    }

    setup();
    const bad = await call('?range=1000d');
    expect(bad.res.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_QUERY');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('W3: computes from/to from the server clock, spanning the preset', async () => {
    const before = Date.now();
    await call('?range=7d');
    const after = Date.now();

    const arg = mockRpc.mock.calls[0][1] as { p_from: string; p_to: string };
    const from = Date.parse(arg.p_from);
    const to = Date.parse(arg.p_to);

    // to is "now", from is 7 days before it — bounded, and derived here rather
    // than accepted from the caller.
    expect(to).toBeGreaterThanOrEqual(before - 1000);
    expect(to).toBeLessThanOrEqual(after + 1000);
    expect(Math.round((to - from) / 86_400_000)).toBe(7);
  });

  it('W4: sends ISO timestamps the RPC can parse as timestamptz', async () => {
    await call();
    const arg = mockRpc.mock.calls[0][1] as { p_from: string; p_to: string };
    expect(Number.isNaN(Date.parse(arg.p_from))).toBe(false);
    expect(Number.isNaN(Date.parse(arg.p_to))).toBe(false);
  });
});

// --- 4. Errors are mapped, not leaked ---------------------------------------

describe('error mapping', () => {
  it('E1: a P3J02 (non-member / nonexistent) becomes 403 FORBIDDEN with no raw code', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'P3J02', message: 'Organization not found' } });
    const { res, body } = await call();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(JSON.stringify(body)).not.toContain('P3J02');
    expect(JSON.stringify(body)).not.toContain('Organization not found');
  });

  it('E2: an unmapped RPC error becomes a generic 500, leaking nothing', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'XXXXX', message: 'select * from secrets' } });
    const { res, body } = await call();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('secrets');
  });

  it('E3: a thrown error is caught and returns 500', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('supabase down'));
    const { res, body } = await call();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('supabase down');
  });
});

// --- 5. Unknown is not zero --------------------------------------------------

describe('unknown is passed through, never folded into a total', () => {
  it('U1: unpriced and unconverted counts survive the round trip', async () => {
    mockRpc.mockResolvedValue({
      data: summary({
        totals: {
          events: 5,
          priced_events: 2,
          unpriced_events: 3,
          unconverted_events: 1,
          accounting_cost_micros: 25000,
          quantities: { audio_seconds: 120 },
          costs_by_currency: [{ currency: 'USD', cost_micros: 25000 }],
        },
      }),
      error: null,
    });
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.summary.totals.unpriced_events).toBe(3);
    expect(body.summary.totals.unconverted_events).toBe(1);
    // The priced total is exactly what was recorded — the route did not add
    // the three unpriced calls to it as zeros, nor drop them.
    expect(body.summary.totals.accounting_cost_micros).toBe(25000);
    expect(body.summary.totals.events).toBe(5);
  });

  it('U2: an empty window returns zeros honestly, not a fabricated total', async () => {
    mockRpc.mockResolvedValue({
      data: summary({
        totals: {
          events: 0,
          priced_events: 0,
          unpriced_events: 0,
          unconverted_events: 0,
          accounting_cost_micros: 0,
          quantities: {},
          costs_by_currency: [],
        },
        by_provider: [],
      }),
      error: null,
    });
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.summary.totals.events).toBe(0);
    expect(body.summary.totals.costs_by_currency).toEqual([]);
  });

  it('U3: the response is an aggregate — it carries no per-event provider_reference or customer id', async () => {
    // The RPC returns an aggregate; this asserts the route does not enrich it
    // with anything row-level on the way out.
    const { res, body } = await call();
    expect(res.status).toBe(200);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('provider_reference');
    expect(wire).not.toContain('request_id');
    expect(wire).not.toContain('contact_phone');
  });
});
