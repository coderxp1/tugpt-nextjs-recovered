// GET /api/v1/media/jobs/:jobId — Single media job detail.
//
// The lookup is scoped to the active tenant's organization_id: an unknown
// id and another org's job both answer 404 MEDIA_JOB_NOT_FOUND, so
// existence does not leak across tenants.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { MediaApiService } from '@/lib/media-api/service';
import { checkMediaFeatureGate } from '@/lib/media-api/feature-gate';
import type { ApiError } from '@/lib/media-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET(
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

    const mediaService = new MediaApiService(supabase, adminClient);
    const job = await mediaService.getMediaJob(activeTenant.organizationId, jobId);

    if (!job) {
      return errorResponse(404, 'MEDIA_JOB_NOT_FOUND', 'Media job not found');
    }

    return NextResponse.json({ job });
  } catch (err) {
    defaultLogger.error('Media job detail failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
