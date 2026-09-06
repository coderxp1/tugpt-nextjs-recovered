import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * @file transcription-queue-adapter.ts
 * @description PGMQ adapter for the `transcription` queue.
 *
 * The same five verbs, the same shapes and the same error classes as
 * `draft-queue-adapter.ts`, because the runbooks and the operational queries
 * already speak that vocabulary. Every queue operation goes through a
 * service-role RPC; nothing here touches the `pgmq` schema directly, which is
 * why `anon` and `authenticated` hold no privilege on it.
 */

export interface TranscriptionQueueMessage {
  msgId: bigint;
  readCt: number;
  payload: Record<string, unknown>;
  enqueuedAt: string;
  vt: string;
}

/**
 * Default lease, matching the RPC's own default and for the same reason: an
 * attempt downloads media and then waits on Gladia for up to 300s, and a lease
 * that expires mid-wait hands the job to a second worker while the first is
 * still legitimately waiting.
 */
export const TRANSCRIPTION_DEFAULT_VISIBILITY_SECONDS = 120;

export class TranscriptionPgmqAdapter {
  constructor(private client: SupabaseClient) {}

  /**
   * Claim work.
   *
   * The RPC reconciles `transcription_jobs.attempts` to PGMQ's `read_ct`,
   * discards messages for jobs that already finished, and dead-letters the
   * over-limit delivery internally — so a message returned here is always work
   * that has not been paid for yet.
   */
  async readJobs(
    limit = 1,
    visibilityTimeoutSeconds = TRANSCRIPTION_DEFAULT_VISIBILITY_SECONDS
  ): Promise<TranscriptionQueueMessage[]> {
    const { data, error } = await this.client.rpc('read_transcription_jobs', {
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
      p_limit: limit,
    });

    if (error) {
      throw new TranscriptionQueueReadError(error.code || 'UNKNOWN');
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
    const { data, error } = await this.client.rpc('delete_transcription_job', {
      p_msg_id: msgId.toString(),
    });

    if (error) {
      throw new TranscriptionQueueDeleteError(error.code || 'UNKNOWN');
    }

    return data === true;
  }

  /** Shorten or extend a message's lease, which is how a transient retry backs off. */
  async setVisibility(msgId: bigint, visibilityTimeoutSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('set_transcription_visibility', {
      p_msg_id: msgId.toString(),
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
    });

    if (error) {
      throw new TranscriptionQueueVisibilityError(error.code || 'UNKNOWN');
    }

    return data === true;
  }
}

export class TranscriptionQueueReadError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'TranscriptionQueueReadError';
  }
}

export class TranscriptionQueueDeleteError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'TranscriptionQueueDeleteError';
  }
}

export class TranscriptionQueueVisibilityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'TranscriptionQueueVisibilityError';
  }
}
