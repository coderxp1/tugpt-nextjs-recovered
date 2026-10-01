// GET /api/v1/media/jobs/:jobId/result — Signed URL for the job's result.
//
// The `media` bucket is private with no customer-facing storage policies
// by design (20260927000001): the API authorizes the caller with the
// org-scoped job read, then mints a short-lived signed URL through the
// service-role client.
//
// 200 { url, expiresIn } — expiresIn is seconds (300).
// 404 MEDIA_JOB_NOT_FOUND — unknown id or another org's job.
// 409 INVALID_MEDIA_JOB_STATE — the job has not completed.
// 404 MEDIA_RESULT_NOT_FOUND — completed but no result_path recorded yet.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import {
  MediaApiService,
  RESULT_URL_EXPIRES_IN,
} from '@/lib/media-api/service';
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

    if (job.status !== 'completed') {
      return errorResponse(
        409,
        'INVALID_MEDIA_JOB_STATE',
        'This media job has not completed'
      );
    }

    if (!job.resultPath) {
      return errorResponse(
        404,
        'MEDIA_RESULT_NOT_FOUND',
        'This media job has no result yet'
      );
    }

    const url = await mediaService.createResultSignedUrl(job.resultPath);

    defaultLogger.info('Media result URL minted', {
      requestId,
      organizationId: activeTenant.organizationId,
      jobId,
    });

    return NextResponse.json({ url, expiresIn: RESULT_URL_EXPIRES_IN });
  } catch (err) {
    defaultLogger.error('Media result URL failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
