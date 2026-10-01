// Media API types — the HTTP contract for /api/v1/media/jobs.
//
// A MediaJob is the camelCase projection of public.media_generation_jobs.
// `params` stays opaque: the adapter owns the render-parameter schema and
// the API must not invent a second one to keep in sync.

export type MediaJobKind = 'image' | 'video';

/**
 * The cost lane a submission is billed against. Image jobs are always the
 * image lane; video jobs are the lightning or quality lane (see
 * 20260928000002 — the quality lane costs ~5x the GPU time of lightning,
 * so each lane has its own quota caps).
 */
export type MediaLane = 'image' | 'lightning' | 'quality';

export type MediaJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'skipped'
  | 'cancelled'
  | 'dead_lettered';

/** Statuses after which the job will never change again. */
export const TERMINAL_STATUSES: ReadonlySet<MediaJobStatus> = new Set([
  'completed',
  'skipped',
  'cancelled',
  'dead_lettered',
]);

/** Statuses the list page offers as filters. `skipped` is visible under `all`. */
export type MediaStatusFilter =
  | 'all'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'dead_lettered';

export interface MediaJob {
  id: string;
  kind: MediaJobKind;
  status: MediaJobStatus;
  prompt: string;
  /** Opaque render parameters, owned by the ComfyUI adapter. */
  params: Record<string, unknown>;
  promptId: string | null;
  attempts: number;
  idempotencyKey: string | null;
  errorCode: string | null;
  errorReason: string | null;
  cancelReason: string | null;
  /** Storage object key inside the private `media` bucket, e.g. <org_id>/<job_id>.png. */
  resultPath: string | null;
  gpuSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MediaJobListResponse {
  jobs: MediaJob[];
  total: number;
  page: number;
  limit: number;
}

export interface MediaJobDetailResponse {
  job: MediaJob;
}

export interface MediaJobSubmitRequest {
  kind: MediaJobKind;
  prompt: string;
  negativePrompt?: string;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface MediaJobCancelRequest {
  reason?: string;
}

export interface MediaJobResultResponse {
  url: string;
  /** Signed-URL lifetime in seconds. */
  expiresIn: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

/** Map a media_generation_jobs row (snake_case) to the MediaJob DTO. */
export function toMediaJob(row: Record<string, unknown>): MediaJob {
  return {
    id: row['id'] as string,
    kind: row['kind'] as MediaJobKind,
    status: row['status'] as MediaJobStatus,
    prompt: row['prompt'] as string,
    params: (row['params'] as Record<string, unknown>) ?? {},
    promptId: (row['prompt_id'] as string | null) ?? null,
    attempts: (row['attempts'] as number) ?? 0,
    idempotencyKey: (row['idempotency_key'] as string | null) ?? null,
    errorCode: (row['error_code'] as string | null) ?? null,
    errorReason: (row['error_reason'] as string | null) ?? null,
    cancelReason: (row['cancel_reason'] as string | null) ?? null,
    resultPath: (row['result_path'] as string | null) ?? null,
    gpuSeconds: (row['gpu_seconds'] as number | null) ?? null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    startedAt: (row['started_at'] as string | null) ?? null,
    finishedAt: (row['finished_at'] as string | null) ?? null,
  };
}
