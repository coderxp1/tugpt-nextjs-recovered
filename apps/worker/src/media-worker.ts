/**
 * @file media-worker.ts
 * @description Dedicated queue processor for ComfyUI media generation jobs.
 *
 * Implements one-consumer-per-queue worker pattern for the `media_jobs` queue,
 * consuming RPCs from 20260927000001_media_capability.sql.
 */

import { PgmqAdapter } from '@tugpt/jobs';
import { ComfyUIAdapter, MediaGenerationRequest } from '@tugpt/ai-providers';

export interface MediaWorkerOptions {
  readonly pollIntervalMs?: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly maxWaitMs?: number;
}

export class MediaWorker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly queue: PgmqAdapter;
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
    this.queue = new PgmqAdapter(client);
    this.adapterFactory = adapterFactory;
    this.pollIntervalMs = options?.pollIntervalMs ?? 5000;
    this.visibilityTimeoutSeconds = options?.visibilityTimeoutSeconds ?? 60;
    this.maxWaitMs = options?.maxWaitMs ?? 600000;
  }

  async run(signal: AbortSignal): Promise<void> {
    console.log(JSON.stringify({ service: 'media-worker', status: 'started' }));

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

  async processJob(
    job: { msgId: bigint; readCt: number; payload: Record<string, unknown> },
    signal: AbortSignal
  ): Promise<void> {
    const { msgId, payload } = job;
    const mediaJobId = payload.jobId as string || payload.mediaGenerationJobId as string;
    const organizationId = payload.organizationId as string;
    const kind = (payload.kind as 'image' | 'video') || 'image';
    const prompt = payload.prompt as string;
    const params = (payload.params as Record<string, unknown>) || {};

    if (!mediaJobId || !organizationId || !prompt) {
      // Malformed payload -> dead-letter
      await this.archiveFailed(mediaJobId, msgId, 'INVALID_MEDIA_PARAMS', 'Missing required fields in job payload');
      return;
    }

    const adapter = this.adapterFactory();

    try {
      // 1. Submit prompt to ComfyUI
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

      // Record prompt_id in DB
      await this.client.rpc('record_media_submission', {
        p_job_id: mediaJobId,
        p_prompt_id: submitRes.promptId,
      });

      // 2. Poll ComfyUI /history for completion
      const result = await adapter.pollHistory(submitRes.promptId, signal, this.maxWaitMs);

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
