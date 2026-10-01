import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * @file media-queue-adapter.ts
 * @description PGMQ adapter for the `media_jobs` queue.
 *
 * The same three verbs as the transcription and draft adapters. Every queue
 * operation goes through a service-role media RPC
 * (`read_media_jobs` / `delete_media_job` / `set_media_visibility` from
 * 20260927000001_media_capability.sql); nothing here touches the `pgmq`
 * schema directly, which is why `anon` and `authenticated` hold no privilege
 * on it.
 *
 * The queue payload carries only the job identity (`mediaJobId`); the worker
 * loads the authoritative job row from `media_generation_jobs` and never
 * trusts render parameters from the payload.
 */

export interface MediaQueueMessage {
  msgId: bigint;
  readCt: number;
  payload: Record<string, unknown>;
  enqueuedAt: string;
  vt: string;
}

/**
 * Default lease. A media render can run for minutes (WAN quality), so the
 * lease must outlive the longest single ComfyUI poll cycle the worker runs
 * without extending visibility. The RPC default is 600s; the worker extends
 * the lease while a render is in flight.
 */
export const MEDIA_DEFAULT_VISIBILITY_SECONDS = 600;

export class MediaQueueAdapter {
  constructor(private client: SupabaseClient) {}

  /**
   * Claim work.
   *
   * The RPC reconciles `media_generation_jobs` against the queue: it binds
   * the message id to the job row, discards messages for jobs that already
   * reached a terminal state, and dead-letters over-limit deliveries
   * internally — so a message returned here is work that has not been paid
   * for yet.
   */
  async readJobs(
    limit = 1,
    visibilityTimeoutSeconds = MEDIA_DEFAULT_VISIBILITY_SECONDS
  ): Promise<MediaQueueMessage[]> {
    const { data, error } = await this.client.rpc('read_media_jobs', {
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
      p_limit: limit,
    });

    if (error) {
      throw new MediaQueueReadError(error.code || 'UNKNOWN');
    }

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return [];
    }

    const rows = Array.isArray(data) ? data : [data];
    return rows.map((row: Record<string, unknown>) => ({
      msgId: BigInt(row.msg_id as string | number),
      readCt: row.read_ct as number,
      payload: row.payload as Record<string, unknown>,
      enqueuedAt: row.enqueued_at as string,
      vt: row.vt as string,
    }));
  }

  /** Delete a message after the job reached a successful terminal state. */
  async deleteJob(msgId: bigint): Promise<boolean> {
    const { data, error } = await this.client.rpc('delete_media_job', {
      p_msg_id: msgId.toString(),
    });

    if (error) {
      throw new MediaQueueDeleteError(error.code || 'UNKNOWN');
    }

    return data === true;
  }

  /** Shorten or extend a message's lease, which is how a long render holds its claim. */
  async setVisibility(msgId: bigint, visibilityTimeoutSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('set_media_visibility', {
      p_msg_id: msgId.toString(),
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
    });

    if (error) {
      throw new MediaQueueVisibilityError(error.code || 'UNKNOWN');
    }

    return data === true;
  }
}

export class MediaQueueReadError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'MediaQueueReadError';
  }
}

export class MediaQueueDeleteError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'MediaQueueDeleteError';
  }
}

export class MediaQueueVisibilityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'MediaQueueVisibilityError';
  }
}
