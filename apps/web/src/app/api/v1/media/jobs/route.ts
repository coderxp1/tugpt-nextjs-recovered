// POST /api/v1/media/jobs — Submit a media generation job (202 on success).
// GET  /api/v1/media/jobs — List jobs for the active organization.
//
// Both mirror apps/web/src/app/api/v1/drafts/route.ts: x-request-id and
// x-tenant-id headers, AuthService.resolveTenantContext, the
// { error: { code, message } } envelope, and a service-role feature-gate
// check before any business logic. The submit path resolves the cost lane
// (image → image lane; video → params.lane, default lightning) and runs
// the per-lane quota gate before enqueueing.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { MediaApiService } from '@/lib/media-api/service';
import { checkMediaFeatureGate } from '@/lib/media-api/feature-gate';
import { mapMediaRpcError } from '@/lib/media-api/error-mapper';
import { validateSubmitBody } from '@/lib/media-api/validation';
import type { ApiError, MediaJobStatus } from '@/lib/media-api/types';

const VALID_STATUSES: Array<'all' | MediaJobStatus> = [
  'all',
  'queued',
  'processing',
  'completed',
  'cancelled',
  'dead_lettered',
];

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
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
      return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    }

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const gate = await checkMediaFeatureGate(adminClient, activeTenant.organizationId);
    if (!gate.allowed) {
      return errorResponse(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON');
    }

    const validated = validateSubmitBody(body);
    if (!validated.ok) {
      return errorResponse(400, validated.code, validated.message);
    }

    const mediaService = new MediaApiService(supabase, adminClient);
    const job = await mediaService.submitMediaJob(
      activeTenant.organizationId,
      user.id,
      validated.value
    );

    defaultLogger.info('Media job submitted', {
      requestId,
      organizationId: activeTenant.organizationId,
      jobId: job.id,
      kind: job.kind,
    });

    return NextResponse.json({ job }, { status: 202 });
  } catch (err) {
    const mapped = mapMediaRpcError(err);
    if (mapped.status >= 500) {
      defaultLogger.error('Media job submit failed', err as Error, { requestId });
    }
    return errorResponse(mapped.status, mapped.code, mapped.message);
  }
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
      return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    }

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const gate = await checkMediaFeatureGate(adminClient, activeTenant.organizationId);
    if (!gate.allowed) {
      return errorResponse(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message);
    }

    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status') || 'all';
    const pageParam = url.searchParams.get('page') || '1';
    const limitParam = url.searchParams.get('limit') || '20';

    if (!VALID_STATUSES.includes(statusParam as MediaJobStatus | 'all')) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid status filter');
    }

    const page = parseInt(pageParam, 10);
    const limit = parseInt(limitParam, 10);
    if (isNaN(page) || page < 1) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid page number');
    }
    if (isNaN(limit) || limit < 1) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid limit');
    }

    const mediaService = new MediaApiService(supabase, adminClient);
    const { jobs, total } = await mediaService.listMediaJobs(
      activeTenant.organizationId,
      statusParam as 'all' | MediaJobStatus,
      page,
      limit
    );

    defaultLogger.info('Media jobs listed', {
      requestId,
      organizationId: activeTenant.organizationId,
      count: jobs.length,
    });

    return NextResponse.json({ jobs, total, page, limit });
  } catch (err) {
    defaultLogger.error('Media job list failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
