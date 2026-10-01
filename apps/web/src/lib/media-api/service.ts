// Media API service layer.
// Encapsulates Supabase access for media job submission, listing, detail,
// cancellation, and result retrieval.
//
// Two clients, two jobs: the user-session client is used for reads so RLS
// applies automatically (every read also filters by the resolved active
// tenant's organization_id — RLS answers "may this user see the row", the
// explicit filter answers "is this row part of the org the caller asked
// about"); the service-role client is used for the RPCs and for minting
// signed URLs, because the media RPCs are granted to service_role only and
// there are deliberately no customer-facing storage policies on the private
// `media` bucket (see 20260927000001).

import type { TypedSupabaseClient } from '@tugpt/database';
import type {
  MediaJob,
  MediaJobKind,
  MediaJobStatus,
  MediaJobSubmitRequest,
  MediaLane,
} from './types';
import { toMediaJob } from './types';

const JOBS_TABLE = 'media_generation_jobs';
const MEDIA_BUCKET = 'media';

/** Lifetime of a result signed URL, in seconds. */
export const RESULT_URL_EXPIRES_IN = 300;

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;

/**
 * Resolve the cost lane for a submission, mirroring the database's
 * lane derivation in 20260928000002: image jobs are always the image
 * lane (any lane param is ignored); video jobs read params.lane and
 * default to 'lightning' — the adapter's prod default — when absent.
 *
 * Throws a P3M12-coded error for an invalid lane so the route answers
 * 400 INVALID_REQUEST through the normal SQLSTATE mapping. Runs before
 * the quota check so a malformed lane never consumes a quota decision.
 */
export function resolveMediaLane(
  kind: MediaJobKind,
  params?: Record<string, unknown>
): MediaLane {
  if (kind === 'image') {
    return 'image';
  }
  const lane = params?.['lane'];
  if (lane === undefined || lane === null) {
    return 'lightning';
  }
  if (lane === 'lightning' || lane === 'quality') {
    return lane;
  }
  throw {
    code: 'P3M12',
    message: `params.lane must be 'lightning' or 'quality'`,
  };
}

const JOB_COLUMNS = `
  id, kind, status, prompt, params, prompt_id,
  attempts, idempotency_key, error_code, error_reason,
  cancel_reason, result_path, gpu_seconds,
  created_at, updated_at, started_at, finished_at
`;

export class MediaApiService {
  constructor(
    private supabase: TypedSupabaseClient,
    private admin: TypedSupabaseClient
  ) {}

  /**
   * Submit a media job through the atomic submit_media_job RPC: lane
   * resolution + quota gate + reserve + enqueue happen in ONE database
   * transaction under a per-org advisory lock, so the quota check can
   * never be separated from the reservation it guards. Throws the raw RPC
   * error (P3Mxx) for the route to map — P3M16 (quota, with the lane in
   * the detail), P3M09/P3M10/P3M12/P3M13/P3M14 from the enqueue step.
   *
   * The top-level negativePrompt is folded into params.negativePrompt
   * because that is where the media worker reads it (media-worker.ts);
   * an explicit params.negativePrompt wins over the top-level one.
   */
  async submitMediaJob(
    organizationId: string,
    userId: string,
    input: MediaJobSubmitRequest
  ): Promise<MediaJob> {
    // The lane is validated client-side first so a malformed lane answers
    // 400 without touching the database at all.
    resolveMediaLane(input.kind, input.params);

    const params: Record<string, unknown> = { ...(input.params ?? {}) };
    if (input.negativePrompt !== undefined && params['negativePrompt'] === undefined) {
      params['negativePrompt'] = input.negativePrompt;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const submitted = await (this.admin as any).rpc('submit_media_job', {
      p_user_id: userId,
      p_organization_id: organizationId,
      p_kind: input.kind,
      p_prompt: input.prompt,
      p_params: params,
      p_idempotency_key: input.idempotencyKey ?? null,
    });
    if (submitted.error) {
      throw submitted.error;
    }

    const rows = submitted.data as Array<{ job_id: string }> | null;
    const jobId = rows?.[0]?.job_id;
    if (!jobId) {
      throw new Error('submit_media_job returned no job id');
    }

    const job = await this.getMediaJob(organizationId, jobId);
    if (!job) {
      throw new Error('submitted media job is not visible to the caller');
    }
    return job;
  }

  /**
   * List media jobs for the active organization with optional status filter
   * and pagination. Reads go through the user-session client (RLS).
   */
  async listMediaJobs(
    organizationId: string,
    status: 'all' | MediaJobStatus = 'all',
    page: number = 1,
    limit: number = DEFAULT_LIST_LIMIT
  ): Promise<{ jobs: MediaJob[]; total: number }> {
    const offset = (page - 1) * limit;
    const clampedLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    let query = this.supabase
      .from(JOBS_TABLE)
      .select(JOB_COLUMNS, { count: 'exact' })
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    // .range() is last: it resolves the builder (the mock's range returns
    // the result, mirroring the drafts service), so no filter may follow it.
    const { data, error, count } = await query.range(
      offset,
      offset + clampedLimit - 1
    );

    if (error) {
      throw error;
    }

    const jobs = ((data || []) as unknown as Array<Record<string, unknown>>).map(
      toMediaJob
    );
    return { jobs, total: count || 0 };
  }

  /**
   * Get a single media job, scoped to the active organization.
   * Returns null for unknown ids AND for other orgs' jobs — the route
   * answers 404 in both cases so existence does not leak across tenants.
   */
  async getMediaJob(
    organizationId: string,
    jobId: string
  ): Promise<MediaJob | null> {
    const { data, error } = await this.supabase
      .from(JOBS_TABLE)
      .select(JOB_COLUMNS)
      .eq('id', jobId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !data) {
      return null;
    }

    return toMediaJob(data as unknown as Record<string, unknown>);
  }

  /**
   * Cancel a media job through the service-role client (the RPC re-checks
   * membership and state). Throws the raw RPC error for the route to map.
   */
  async cancelMediaJob(
    organizationId: string,
    userId: string,
    jobId: string,
    reason?: string
  ): Promise<MediaJob | null> {
    // The RPC raises P3M01 for an unknown job and P3M13 when the caller is
    // not a member of the job's org — both map to 404/403 without leaking
    // which one it was. But the org-scoped read below already refuses
    // cross-org jobs, so check existence in this org first and answer null
    // (→ 404) rather than letting the RPC's tenant check speak.
    const existing = await this.getMediaJob(organizationId, jobId);
    if (!existing) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelled = await (this.admin as any).rpc('cancel_media_job', {
      p_user_id: userId,
      p_job_id: jobId,
      p_reason: reason ?? 'Cancelled by user',
    });
    if (cancelled.error) {
      throw cancelled.error;
    }

    return this.getMediaJob(organizationId, jobId);
  }

  /**
   * Mint a short-lived signed URL for a completed job's result.
   * Uses the service-role client — there are no customer-facing storage
   * policies on the private `media` bucket by design, so the API mints
   * the URL after the org-scoped read above has authorized the caller.
   */
  async createResultSignedUrl(resultPath: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = (this.admin as any).storage;
    const { data, error } = await storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(resultPath, RESULT_URL_EXPIRES_IN);

    if (error || !data?.signedUrl) {
      throw error ?? new Error('could not mint a signed URL for the result');
    }

    return data.signedUrl as string;
  }
}

/** Re-exported so routes do not reach past the service for these. */
export type { MediaJobKind, MediaJobStatus, MediaLane };
