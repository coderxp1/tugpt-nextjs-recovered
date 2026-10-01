// POST /api/v1/media/jobs/:jobId/cancel — Cancel a queued/processing job.
//
// Body: { reason?: string }. The cancel RPC validates the reason
// (P3M12), re-checks membership (P3M13), and refuses terminal jobs
// (P3M11 → 409 INVALID_MEDIA_JOB_STATE). Unknown ids and other orgs'
// jobs answer 404 MEDIA_JOB_NOT_FOUND.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { MediaApiService } from '@/lib/media-api/service';
import { checkMediaFeatureGate } from '@/lib/media-api/feature-gate';
import { mapMediaRpcError } from '@/lib/media-api/error-mapper';
import type { ApiError } from '@/lib/media-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  try {
    const { jobId } = await params;

    if (!UUID_REGEX.test(jobId)) {
      return errorResponse(400, 'INVALID_UUID', 'Invalid job ID format');
    }

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

    let body: unknown = {};
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON');
    }

    const reason =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)['reason']
        : undefined;
    if (reason !== undefined && typeof reason !== 'string') {
      return errorResponse(400, 'INVALID_REQUEST', 'reason must be a string');
    }

    const mediaService = new MediaApiService(supabase, adminClient);
    const job = await mediaService.cancelMediaJob(
      activeTenant.organizationId,
      user.id,
      jobId,
      reason
    );

    if (!job) {
      return errorResponse(404, 'MEDIA_JOB_NOT_FOUND', 'Media job not found');
    }

    defaultLogger.info('Media job cancelled', {
      requestId,
      organizationId: activeTenant.organizationId,
      jobId,
    });

    return NextResponse.json({ job });
  } catch (err) {
    const mapped = mapMediaRpcError(err);
    if (mapped.status >= 500) {
      defaultLogger.error('Media job cancel failed', err as Error, { requestId });
    }
    return errorResponse(mapped.status, mapped.code, mapped.message);
  }
}
