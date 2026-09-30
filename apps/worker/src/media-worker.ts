/**
 * @file media-worker.ts
 * @description Dedicated queue processor for ComfyUI media generation jobs.
 *
 * Consumes the `media_jobs` PGMQ queue through MediaQueueAdapter (the actual
 * media RPCs: read_media_jobs / delete_media_job / set_media_visibility).
 *
 * The queue payload carries only the job identity (`mediaJobId`). Every
 * render parameter — organization, kind, prompt, params — is loaded from the
 * authoritative `media_generation_jobs` row, never trusted from the payload.
 */

import { MediaQueueAdapter, MediaQueueMessage } from './media-queue-adapter.js';
import { ComfyUIAdapter, MediaGenerationRequest } from '@tugpt/ai-providers';

export interface MediaWorkerOptions {
  readonly pollIntervalMs?: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly maxWaitMs?: number;
}

interface MediaJobRow {
  id: string;
  organization_id: string;
  kind: 'image' | 'video';
  status: string;
  prompt: string;
  params: Record<string, unknown>;
  prompt_id: string | null;
  attempts: number;
  result_path: string | null;
}

export class MediaWorker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly queue: MediaQueueAdapter;
  private readonly adapterFactory: () => ComfyUIAdapter;
  private readonly pollIntervalMs: number;
  private readonly visibilityTimeoutSeconds: number;
  private readonly maxWaitMs: number;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    adapterFactory: () => ComfyUIAdapter = () => new ComfyUIAdapter(),
    options?: MediaWorkerOptions
  ) {
    this.client = client;
    this.queue = new MediaQueueAdapter(client);
    this.adapterFactory = adapterFactory;
    this.pollIntervalMs = options?.pollIntervalMs ?? 5000;
    this.visibilityTimeoutSeconds = options?.visibilityTimeoutSeconds ?? 600;
    this.maxWaitMs = options?.maxWaitMs ?? 600000;
  }

  async run(signal: AbortSignal): Promise<void> {
    console.log(JSON.stringify({ service: 'media-worker', status: 'started' }));

    // M2 hook: reconcile interrupted jobs before polling for new work.
    await this.recoverInterruptedJobs(signal);

    while (!signal.aborted) {
      try {
        const jobs = await this.queue.readJobs(1, this.visibilityTimeoutSeconds);

        if (jobs.length === 0) {
          await this.sleep(this.pollIntervalMs, signal);
          continue;
        }

        for (const job of jobs) {
          if (signal.aborted) break;
          await this.processJob(job, signal);
        }
      } catch (err: unknown) {
        if (signal.aborted) break;
        console.error(JSON.stringify({
          service: 'media-worker',
          errorCode: 'QUEUE_READ_ERROR',
          message: (err as Error).message,
        }));
        await this.sleep(this.pollIntervalMs, signal);
      }
    }

    console.log(JSON.stringify({ service: 'media-worker', status: 'stopped' }));
  }

  /**
   * Load the authoritative job row. The queue payload is identity only;
   * everything the render needs comes from this row.
   */
  private async loadJobRow(mediaJobId: string): Promise<MediaJobRow | null> {
    const { data, error } = await this.client
      .from('media_generation_jobs')
      .select('id, organization_id, kind, status, prompt, params, prompt_id, attempts, result_path')
      .eq('id', mediaJobId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load job row: ${error.message}`);
    }

    return data as MediaJobRow | null;
  }

  async processJob(job: MediaQueueMessage, signal: AbortSignal): Promise<void> {
    const { msgId, payload } = job;
    const mediaJobId = payload.mediaJobId as string;

    if (!mediaJobId) {
      // Malformed payload: no job identity at all -> dead-letter the message.
      await this.queue.deleteJob(msgId);
      console.error(JSON.stringify({
        service: 'media-worker',
        errorCode: 'INVALID_MEDIA_PAYLOAD',
        message: 'Queue message missing mediaJobId',
      }));
      return;
    }

    // Authoritative job row: the single source of truth for render inputs.
    let jobRow: MediaJobRow | null;
    try {
      jobRow = await this.loadJobRow(mediaJobId);
    } catch (err: unknown) {
      // DB read failed: leave the message; the lease expires and it redelivers.
      console.error(JSON.stringify({
        service: 'media-worker',
        errorCode: 'JOB_ROW_READ_ERROR',
        jobId: mediaJobId,
        message: (err as Error).message,
      }));
      return;
    }

    if (!jobRow) {
      // Queue message with no job row: archive the message, nothing to render.
      await this.archiveFailed(mediaJobId, msgId, 'INVALID_MEDIA_JOB', 'No media_generation_jobs row for queue message');
      return;
    }

    // The read_media_jobs RPC already discards terminal-state messages, but
    // a concurrent cancel can land between claim and here — never render a
    // job that is no longer queued/processing.
    if (jobRow.status !== 'queued' && jobRow.status !== 'processing') {
      await this.queue.deleteJob(msgId);
      console.log(JSON.stringify({
        service: 'media-worker',
        status: 'skipped-terminal',
        jobId: mediaJobId,
        jobStatus: jobRow.status,
      }));
      return;
    }

    const organizationId = jobRow.organization_id;
    const kind = jobRow.kind;
    const prompt = jobRow.prompt;
    const params = jobRow.params || {};

    if (!organizationId || !prompt || (kind !== 'image' && kind !== 'video')) {
      await this.archiveFailed(mediaJobId, msgId, 'INVALID_MEDIA_PARAMS', 'Job row missing required render fields');
      return;
    }

    const adapter = this.adapterFactory();

    try {
      // 1. Submit prompt to ComfyUI — unless a previous attempt already did.
      // A stored prompt_id means ComfyUI accepted the job; resubmitting would
      // render (and bill) twice. Reconcile instead (M2).
      let promptId = jobRow.prompt_id;
      if (!promptId) {
        const req: MediaGenerationRequest = {
          organizationId,
          jobId: mediaJobId,
          domain: kind,
          lane: (params.lane as 'lightning' | 'quality') || 'lightning',
          prompt,
          width: params.width as number | undefined,
          height: params.height as number | undefined,
          frames: params.frames as number | undefined,
          fps: params.fps as number | undefined,
          seed: params.seed as number | undefined,
        };

        const submitRes = await adapter.submitPrompt(req, signal);
        promptId = submitRes.promptId;

        // Record prompt_id in DB BEFORE any polling — the handle that makes
        // a timeout resumable instead of re-rendered.
        await this.client.rpc('record_media_submission', {
          p_job_id: mediaJobId,
          p_prompt_id: promptId,
        });
      } else {
        console.log(JSON.stringify({
          service: 'media-worker',
          status: 'reconciling-prompt',
          jobId: mediaJobId,
          promptId,
        }));
      }

      // 2. Poll ComfyUI /history for completion, extending the queue lease
      // while the render is in flight so no second worker claims it.
      const result = await this.pollWithLease(adapter, promptId, msgId, signal);

      if (result.status === 'completed' && result.output) {
        // Fetch output file bytes
        const fileBytes = await adapter.fetchOutputBytes(result.output, signal);

        // Upload to Supabase Storage under media bucket at <org_id>/<job_id>.<ext>
        const ext = kind === 'video' ? 'mp4' : 'png';
        const storagePath = `${organizationId}/${mediaJobId}.${ext}`;

        const { error: uploadError } = await this.client.storage
          .from('media')
          .upload(storagePath, fileBytes, {
            contentType: kind === 'video' ? 'video/mp4' : 'image/png',
            upsert: true,
          });

        if (uploadError) {
          throw new Error(`Storage upload failed: ${uploadError.message}`);
        }

        // Complete job in DB
        await this.client.rpc('complete_media_job', {
          p_job_id: mediaJobId,
          p_result_path: storagePath,
          p_gpu_seconds: Math.ceil(result.latencyMs / 1000),
        });

        // Delete from PGMQ queue
        await this.queue.deleteJob(msgId);
      } else if (result.status === 'cancelled') {
        await this.archiveFailed(mediaJobId, msgId, 'MEDIA_INTERRUPTED', result.errorDetail || 'Job interrupted');
      } else if (result.status === 'timed_out') {
        await this.archiveFailed(mediaJobId, msgId, 'MEDIA_TIMEOUT', result.errorDetail || 'Job timed out');
      } else {
        await this.archiveFailed(mediaJobId, msgId, result.errorCode || 'MEDIA_EXECUTION_ERROR', result.errorDetail || 'ComfyUI render failed');
      }
    } catch (err: unknown) {
      await this.archiveFailed(mediaJobId, msgId, 'MEDIA_EXECUTION_ERROR', (err as Error).message);
    }
  }

  /**
   * Poll ComfyUI for completion while extending the PGMQ lease, so a render
   * longer than the initial visibility timeout is not claimed twice.
   */
  private async pollWithLease(
    adapter: ComfyUIAdapter,
    promptId: string,
    msgId: bigint,
    signal: AbortSignal
  ) {
    // Extend the lease in the background while polling.
    const leaseTimer = setInterval(() => {
      this.queue.setVisibility(msgId, this.visibilityTimeoutSeconds).catch((err: unknown) => {
        console.error(JSON.stringify({
          service: 'media-worker',
          errorCode: 'LEASE_EXTEND_ERROR',
          message: (err as Error).message,
        }));
      });
    }, Math.floor(this.visibilityTimeoutSeconds / 2) * 1000);
    // Do not hold the process open on this timer alone.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (leaseTimer as any).unref?.();

    try {
      return await adapter.pollHistory(promptId, signal, this.maxWaitMs);
    } finally {
      clearInterval(leaseTimer);
    }
  }

  /**
   * M2: reconcile interrupted jobs on startup.
   *
   * Any job row in `processing` with a stored `prompt_id` is a render that
   * may still be alive in ComfyUI from before the restart. Reconcile each
   * against /history BEFORE polling for new work: completed results are
   * collected, still-running prompts are adopted, and only genuinely lost
   * work is re-queued. Never silently resubmit.
   *
   * Implemented in M2; the hook is wired here so the ordering guarantee
   * (recover before poll) is structural.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async recoverInterruptedJobs(signal: AbortSignal): Promise<void> {
    // M2 implements this.
  }

  private async archiveFailed(
    jobId: string,
    msgId: bigint,
    errorCode: string,
    errorDetail: string
  ): Promise<void> {
    try {
      if (jobId) {
        await this.client.rpc('archive_media_failed_job', {
          p_job_id: jobId,
          p_error_code: errorCode,
          p_error_detail: errorDetail,
        });
      }
      await this.queue.deleteJob(msgId);
    } catch {
      // Swallowed: best-effort archive
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
