/**
 * GET /api/v1/analytics/usage
 *
 * Analytics v1: what this organization's AI cost it, over a bounded window.
 *
 * WHY THE RPC IS CALLED ON THE USER'S CLIENT, NOT AN ADMIN CLIENT
 *
 * `public.org_usage_summary` checks `auth.uid()` against `organization_members`
 * inside the definer and answers a non-member with the same P3J02 it answers a
 * nonexistent organization — so it cannot be used to enumerate organization
 * ids. That check only means something if the call carries the reviewer's own
 * claims. Calling it on a service-role client would set `auth.uid()` to NULL
 * (P3J01) or, worse, bypass membership entirely if it were written to. So the
 * route resolves the tenant for the *response envelope* and logging, and lets
 * the RPC re-derive and enforce membership from the session on the wire. Two
 * checks, one authority: the database's.
 *
 * WHAT IT DOES NOT RETURN
 *
 * No per-row usage, no provider references, no request ids, no customer or
 * message identifiers. The RPC is an aggregate on purpose (see
 * 20260911000001): a member can see what their organization spent, not walk
 * the underlying events. `provider_usage_events` stays service_role-only; this
 * route is a read path over an aggregate, not a relaxation of that.
 *
 * WHAT IT DOES NOT INVENT
 *
 * Cost is returned exactly as recorded: native-currency totals as a list, a
 * converted total in the accounting currency, and — separately — the count of
 * unpriced and unconverted events. Nothing sums an unknown as zero. The screen
 * is where those counts become a sentence; see `analytics.unpricedNotice`.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import type { UsageSummary } from '@tugpt/database';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import { resolveUsageWindow } from '@/lib/analytics/window';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (!activeTenant) {
      // Not "no membership" and not "no active selection" — the resolver
      // collapses both, and either way there is no organization whose usage
      // this caller may see. Same sentence the inbox route gives.
      return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    }

    const params = new URL(request.url).searchParams;
    const window = resolveUsageWindow(params.get('range'), new Date());
    if (window === null) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid range; use 7d, 30d or 90d');
    }

    const { data, error } = await supabase.rpc(
      'org_usage_summary',
      {
        p_organization_id: activeTenant.organizationId,
        p_from: window.from,
        p_to: window.to,
      } as unknown as undefined
    );

    if (error) {
      const mapped = mapDraftRpcError(error as { code?: string });
      defaultLogger.warn('Usage summary RPC failed', {
        requestId,
        organizationId: activeTenant.organizationId,
        sqlstateCode: (error as { code?: string }).code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    // The args cast above (the codebase's convention for the bundled rpc
    // typing) leaves `data` as `never`; the RPC returns the UsageSummary JSONB
    // and this is where that is said out loud. `?? null` keeps a NULL aggregate
    // — which the RPC never returns, but the wire could — from becoming a
    // crash the caller reads as a 500.
    const summary = (data as unknown as UsageSummary | null) ?? null;

    defaultLogger.info('Usage summary retrieved', {
      requestId,
      organizationId: activeTenant.organizationId,
      range: window.range,
      events: summary?.totals?.events ?? 0,
      unpricedEvents: summary?.totals?.unpriced_events ?? 0,
    });

    return NextResponse.json({
      range: window.range,
      window: { from: window.from, to: window.to },
      summary,
    });
  } catch (err) {
    defaultLogger.error('Usage summary failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
