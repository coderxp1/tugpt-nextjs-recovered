import type { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '@tugpt/observability';
import { ProviderError, type TranscriptionProvider, type TranscriptionResult } from '@tugpt/ai-providers';
import { supportsAudioUpload } from '@tugpt/ai-providers';
import { TranscriptionPgmqAdapter } from './transcription-queue-adapter.js';
import { MediaFetchError, type WhatsAppMediaClient } from './whatsapp-media.js';
import {
  isTransientMediaCode,
  isTransientProviderCategory,
  mapMediaErrorToTranscriptionCode,
  mapProviderErrorToTranscriptionCode,
  type TranscriptionErrorCode,
  type TranscriptionSkipReason,
} from './transcription-rpc-error-codes.js';

/**
 * @file transcription-worker.ts
 * @description Turns an inbound WhatsApp voice note into a transcript on the
 * message it came from, and hands the message to the draft path.
 *
 * Never sends anything to a customer. `whatsapp_integration` gates outbound
 * and this worker has no outbound code path; the media client it uses can only
 * issue GET requests.
 *
 * ===========================================================================
 * THE ONE THING THIS WORKER IS ORGANISED AROUND
 * ===========================================================================
 *
 * **Gladia bills on submission.** Not on completion, not on reading the
 * result — on submission. Every structural decision below follows from that:
 *
 *   * A job that already carries a `provider_job_reference` is RESUMED, never
 *     resubmitted. It does not download the media again, does not upload
 *     again, and does not submit again: it polls the job that was already paid
 *     for. This is the single most expensive mistake available here, and it is
 *     the reason the reference is written before any waiting rather than at
 *     completion.
 *
 *   * The reference is persisted through `onSubmitted`, inside the adapter
 *     call, before it starts polling. If that write fails the error
 *     propagates and no waiting happens — because waiting for a result nobody
 *     can later resume is worse than failing loudly.
 *
 *   * The claim RPC refuses to hand back a job that already finished, so a
 *     stale queue message cannot become a second download and a second
 *     submission.
 *
 *   * Media is size-capped before it is transferred, because the cheapest
 *     place to decline a two-hour recording is before anything moves.
 *
 * ===========================================================================
 * CONTENT PRIVACY
 * ===========================================================================
 *
 * Never logged: the transcript, the audio bytes, the short-lived media URL,
 * the customer's phone number, the Gladia key, the Graph token. Logged:
 * request id, job id, provider name, normalized error category, latency,
 * attempt number, byte count, billed seconds.
 */

/**
 * Retry backoffs, in seconds.
 *
 * Longer than the draft worker's 5s/15s because the work is longer: an attempt
 * can legitimately spend five minutes polling Gladia, so a five-second
 * re-delivery would mostly find the same job in the same state.
 */
const RETRY_DELAY_1 = 30;
const RETRY_DELAY_2 = 60;

/** After the third attempt the job is archived rather than retried. */
const MAX_ATTEMPTS = 3;

const logger = new Logger({ service: 'transcription-worker' });

export interface TranscriptionWorkerConfig {
  pollIntervalMs: number;
  visibilityTimeoutSeconds: number;
}

/**
 * Builds the provider and the media client for one job.
 *
 * A factory rather than injected instances, and called PER JOB rather than
 * once, because both credentials live in `platform_secrets`. A cached client
 * would keep a rotated key alive until the next restart, and rotation that
 * requires a restart is rotation nobody performs during an incident. Two extra
 * selects per voice note is not a cost worth optimising against that.
 *
 * Throwing here is how a missing credential surfaces — see `processJob`.
 */
export type TranscriptionDepsFactory = () => Promise<{
  provider: TranscriptionProvider;
  media: WhatsAppMediaClient;
}>;

interface TranscriptionJobRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  source_message_id: string;
  media_reference: string;
  media_mime_type: string | null;
  provider_job_reference: string | null;
}

export class TranscriptionWorker {
  private client: SupabaseClient;
  private queue: TranscriptionPgmqAdapter;
  private buildDeps: TranscriptionDepsFactory;
  private pollIntervalMs: number;
  private visibilityTimeoutSeconds: number;

  constructor(
    client: SupabaseClient,
    buildDeps: TranscriptionDepsFactory,
    config: TranscriptionWorkerConfig
  ) {
    this.client = client;
    this.queue = new TranscriptionPgmqAdapter(client);
    this.buildDeps = buildDeps;
    this.pollIntervalMs = config.pollIntervalMs;
    this.visibilityTimeoutSeconds = config.visibilityTimeoutSeconds;
  }

  async run(signal: AbortSignal): Promise<void> {
    logger.info('Transcription worker started', {});

    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
      } catch (err) {
        logger.error('Transcription worker poll error', err as Error, {});
      }
      await this.sleep(this.pollIntervalMs, signal);
    }

    logger.info('Transcription worker shutting down', {});
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const jobs = await this.queue.readJobs(1, this.visibilityTimeoutSeconds);
    for (const job of jobs) {
      await this.processJob(job, signal);
    }
  }

  private async processJob(
    job: { msgId: bigint; readCt: number; payload: Record<string, unknown> },
    signal: AbortSignal
  ): Promise<void> {
    const { msgId, readCt, payload } = job;
    const transcriptionJobId = payload.transcriptionJobId as string | undefined;
    const requestId = (payload.requestId as string | undefined) ?? undefined;

    // A message with no job id names nothing. It cannot be archived — the
    // archive RPC dead-letters a JOB, and there is none — and leaving it
    // queued means redelivering it forever. Deleting it loses a pointer to
    // nothing, which is the least bad of the three.
    if (!transcriptionJobId) {
      logger.error('Malformed queue payload: no transcriptionJobId', undefined, {
        queueMessageId: msgId.toString(),
      });
      await this.queue.deleteJob(msgId);
      return;
    }

    logger.info('Processing transcription job', { transcriptionJobId, requestId, attempt: readCt });

    try {
      const jobRow = await this.loadJob(transcriptionJobId);
      if (!jobRow) {
        // Same reasoning as above: nothing to dead-letter.
        logger.error('Transcription job not found', undefined, { transcriptionJobId });
        await this.queue.deleteJob(msgId);
        return;
      }

      // Both flags, mirroring the enqueue gate in migration 20260903000008.
      // `voice_transcription` gates the spend; `ai_draft_generation` is read
      // because transcribing a voice note nobody will draft from is paying to
      // produce a row no reviewer acts on. Not re-litigated here — the enqueue
      // already made that call, and a worker that disagreed with it would
      // transcribe messages the ingest path deliberately declined.
      const skip = await this.resolveSkip(jobRow.organization_id);
      if (skip) {
        logger.info('Feature disabled; skipping transcription job', {
          transcriptionJobId,
          requestId,
          reason: skip,
        });
        await this.skipJob(transcriptionJobId, msgId, skip);
        return;
      }

      let deps: Awaited<ReturnType<TranscriptionDepsFactory>>;
      try {
        deps = await this.buildDeps();
      } catch (err) {
        // A credential that is absent or unusable. Archived immediately rather
        // than retried, with a code that names which credential, because
        // retrying reaches the same answer three times.
        //
        // THE HONEST COST OF THAT CHOICE: if the vault is empty when the flag
        // is switched on, every queued voice note dead-letters, and there is
        // no replay tooling. The log line below is therefore written to be the
        // whole diagnosis, command included.
        const code = this.classifyDepsFailure(err);
        logger.error(
          'Transcription credentials unavailable; archiving. Install them with: secrets-cli put --provider gladia --secret-name api_key',
          err instanceof Error ? err : new Error(String(err)),
          { transcriptionJobId, requestId, errorCode: code }
        );
        await this.archiveFailed(msgId, transcriptionJobId, code);
        return;
      }

      const result = jobRow.provider_job_reference
        ? await this.resumeSubmission(jobRow, deps.provider, requestId, signal)
        : await this.submitFresh(jobRow, deps, requestId, signal);

      await this.completeJob(jobRow, result, requestId);
      await this.recordUsage(jobRow, result, requestId);
      await this.queue.deleteJob(msgId);

      logger.info('Transcription completed', {
        transcriptionJobId,
        requestId,
        provider: result.provider,
        billingSeconds: result.usage.billingSeconds,
        audioSeconds: result.usage.audioSeconds,
        channels: result.usage.channels,
        // Length, never content.
        transcriptLength: result.text.length,
        latencyMs: result.latencyMs,
        attempt: readCt,
      });
    } catch (err) {
      await this.handleFailure(msgId, transcriptionJobId, requestId, readCt, err);
    }
  }

  /**
   * Resume a job the provider has already accepted.
   *
   * No download, no upload, no submission — those all happened on a previous
   * attempt and were billed. This is the branch that makes a timeout cost
   * nothing extra.
   */
  private async resumeSubmission(
    jobRow: TranscriptionJobRow,
    provider: TranscriptionProvider,
    requestId: string | undefined,
    signal: AbortSignal
  ): Promise<TranscriptionResult> {
    logger.info('Resuming a submitted transcription rather than resubmitting', {
      transcriptionJobId: jobRow.id,
      requestId,
    });
    return provider.awaitResult(jobRow.provider_job_reference as string, {
      organizationId: jobRow.organization_id,
      ...(requestId ? { requestId } : {}),
      signal,
    });
  }

  /** Download, upload, submit — recording the provider's id before waiting. */
  private async submitFresh(
    jobRow: TranscriptionJobRow,
    deps: { provider: TranscriptionProvider; media: WhatsAppMediaClient },
    requestId: string | undefined,
    signal: AbortSignal
  ): Promise<TranscriptionResult> {
    const { provider, media } = deps;

    if (!supportsAudioUpload(provider)) {
      // Not a runtime accident: WhatsApp media URLs are Authorization-gated,
      // so a provider that can only fetch a URL cannot transcribe them at all.
      // Failing here says that, rather than sending Gladia a URL it will get a
      // 401 from and reporting it as a provider error.
      throw new ProviderError(
        provider.providerName,
        'INVALID_CONFIGURATION',
        undefined,
        'Provider cannot accept an audio upload, and WhatsApp media cannot be fetched by a third party.'
      );
    }

    const downloaded = await media.fetchAudio(jobRow.media_reference, signal);
    logger.info('Media downloaded', {
      transcriptionJobId: jobRow.id,
      requestId,
      // Size and type only. Never the URL, never the bytes.
      bytes: downloaded.bytes.byteLength,
      mimeType: downloaded.mimeType,
    });

    const source = await provider.uploadAudio(
      {
        bytes: downloaded.bytes,
        // The provider infers format from the bytes; this is only the part
        // name, and it deliberately carries no customer identifier.
        filename: `voice-note-${jobRow.id}`,
        contentType: jobRow.media_mime_type || downloaded.mimeType,
      },
      { organizationId: jobRow.organization_id, ...(requestId ? { requestId } : {}), signal }
    );

    return provider.transcribe(source, {
      organizationId: jobRow.organization_id,
      ...(requestId ? { requestId } : {}),
      signal,
      onSubmitted: async (providerJobId) => {
        // Before any polling. If this throws, the adapter propagates it and
        // never waits — deliberately, because a billed job whose handle was
        // not recorded can only be recovered by paying again.
        await this.recordSubmission(jobRow.id, provider.providerName, providerJobId);
      },
    });
  }

  // --- Database helpers ------------------------------------------------------

  private async loadJob(jobId: string): Promise<TranscriptionJobRow | null> {
    const { data, error } = await this.client
      .from('transcription_jobs')
      .select(
        'id, organization_id, conversation_id, source_message_id, media_reference, media_mime_type, provider_job_reference'
      )
      .eq('id', jobId)
      .single();

    if (error || !data) {
      return null;
    }
    return data as TranscriptionJobRow;
  }

  private async isFeatureEnabled(organizationId: string, flagKey: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('is_feature_enabled', {
      p_organization_id: organizationId,
      p_flag_key: flagKey,
    });

    // Closed by default. A flag lookup that failed is not permission to spend.
    if (error || data === null) {
      return false;
    }
    return data as boolean;
  }

  private async resolveSkip(organizationId: string): Promise<TranscriptionSkipReason | null> {
    if (!(await this.isFeatureEnabled(organizationId, 'voice_transcription'))) {
      return 'FEATURE_DISABLED';
    }
    if (!(await this.isFeatureEnabled(organizationId, 'ai_draft_generation'))) {
      return 'DRAFT_DISABLED';
    }
    return null;
  }

  private async recordSubmission(
    jobId: string,
    provider: string,
    providerJobId: string
  ): Promise<void> {
    const { error } = await this.client.rpc('record_transcription_submission', {
      p_job_id: jobId,
      p_provider: provider,
      p_provider_job_reference: providerJobId,
    });

    if (error) {
      // Thrown, not logged and swallowed. The adapter's contract is that
      // anything onSubmitted throws propagates before it starts waiting, and
      // that is the behaviour wanted here: a handle we could not store is work
      // we cannot resume.
      throw new Error(`record_transcription_submission failed: ${error.code || 'UNKNOWN'}`);
    }
  }

  private async completeJob(
    jobRow: TranscriptionJobRow,
    result: TranscriptionResult,
    requestId: string | undefined
  ): Promise<void> {
    const { error } = await this.client.rpc('complete_transcription_job', {
      p_job_id: jobRow.id,
      p_transcript: result.text,
      p_provider: result.provider,
      p_provider_job_reference: result.id,
      p_language_code: result.languageCode ?? null,
    });

    if (error) {
      throw new Error(`complete_transcription_job failed: ${error.code || 'UNKNOWN'}`);
    }

    logger.info('Transcript stored', {
      transcriptionJobId: jobRow.id,
      requestId,
      languageCode: result.languageCode ?? null,
    });
  }

  /**
   * Record what the call will be billed for.
   *
   * After completion, and swallowing its own errors, for the reason the draft
   * worker's equivalent does: by the time this runs the transcript is on the
   * message and Gladia has already charged, so failing the job here would
   * retry work that is finished. A failure is logged WITH THE QUANTITIES so
   * the number is recoverable by hand.
   *
   * `billingSeconds` is Gladia's own billed quantity (audio duration times
   * channels), not the wall-clock length — the distinction that would
   * understate every stereo recording by exactly 100%. It is rounded UP,
   * because the rounding direction on a cost is a choice and under-reporting
   * spend is the wrong one.
   */
  private async recordUsage(
    jobRow: TranscriptionJobRow,
    result: TranscriptionResult,
    requestId: string | undefined
  ): Promise<void> {
    const audioSeconds = Math.ceil(result.usage.billingSeconds);

    try {
      if (audioSeconds <= 0) {
        // record_provider_usage rejects an empty quantities object, and a
        // zero-second row would price at zero anyway. Nothing was measurable;
        // say so rather than writing a number that looks measured.
        logger.info('No billable seconds reported; no usage row written', {
          transcriptionJobId: jobRow.id,
          requestId,
          provider: result.provider,
        });
        return;
      }

      const { error } = await this.client.rpc('record_provider_usage', {
        p_organization_id: jobRow.organization_id,
        p_modality: 'audio',
        p_provider: result.provider,
        p_model: result.model,
        p_quantities: { audio_seconds: audioSeconds },
        p_provider_reference: result.id,
        p_request_id: requestId ?? jobRow.id,
        p_draft_generation_job_id: null,
        p_message_id: jobRow.source_message_id,
        p_metadata: {
          latency_ms: result.latencyMs,
          // Kept because the gap between these two IS the thing worth being
          // able to see: a stereo file bills at twice its length.
          audio_duration_seconds: result.usage.audioSeconds,
          channels: result.usage.channels,
        },
      });

      if (error) {
        throw new Error(error.message);
      }
    } catch (err) {
      logger.error(
        'Failed to record transcription usage; the transcript is unaffected',
        err instanceof Error ? err : new Error(String(err)),
        {
          transcriptionJobId: jobRow.id,
          requestId,
          provider: result.provider,
          // Logged so the cost is reconstructible by hand. A row we could not
          // write is recoverable; a number we never printed is not.
          audioSeconds,
          billingSeconds: result.usage.billingSeconds,
          channels: result.usage.channels,
        }
      );
    }
  }

  // --- Failure handling ------------------------------------------------------

  /** Which credential was missing, so the dead-letter names the fix. */
  private classifyDepsFailure(err: unknown): TranscriptionErrorCode {
    if (err instanceof MediaFetchError) {
      return mapMediaErrorToTranscriptionCode(err.code);
    }
    if (err instanceof ProviderError) {
      return mapProviderErrorToTranscriptionCode(err.category);
    }
    return 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR';
  }

  /**
   * Decide, for one thrown thing, between backing off and terminating.
   *
   * The transient/terminal split is the money decision (see
   * `transcription-rpc-error-codes.ts`); this is where it is applied, and the
   * two shapes of failure — media and provider — go through the same branch so
   * a change to the retry policy cannot apply to one and not the other.
   */
  private async handleFailure(
    msgId: bigint,
    transcriptionJobId: string,
    requestId: string | undefined,
    readCt: number,
    err: unknown
  ): Promise<void> {
    let transient: boolean;
    let terminalCode: TranscriptionErrorCode;
    let detail: string | undefined;
    let category: string;

    if (err instanceof MediaFetchError) {
      transient = isTransientMediaCode(err.code);
      terminalCode = mapMediaErrorToTranscriptionCode(err.code);
      detail = err.detail;
      category = err.code;
    } else if (err instanceof ProviderError) {
      transient = isTransientProviderCategory(err.category);
      terminalCode = mapProviderErrorToTranscriptionCode(err.category);
      detail = err.providerDetail;
      category = err.category;
    } else {
      // An unexpected throw: a database error, a bug. Transient while attempts
      // remain, because the alternative is dead-lettering a voice note over a
      // dropped connection.
      transient = true;
      terminalCode = 'TRANSCRIPTION_INTERNAL_ERROR';
      detail = undefined;
      category = 'INTERNAL';
    }

    logger.error(
      'Transcription attempt failed',
      err instanceof Error ? err : new Error(String(err)),
      { transcriptionJobId, requestId, attempt: readCt, category, transient, providerDetail: detail }
    );

    if (transient && readCt < MAX_ATTEMPTS) {
      await this.queue.setVisibility(msgId, readCt === 1 ? RETRY_DELAY_1 : RETRY_DELAY_2);
      return;
    }

    if (transient) {
      // Retries exhausted. A provider TIMEOUT keeps its own code rather than
      // collapsing into EXHAUSTED_RETRIES: "we stopped waiting for work that
      // was billed" is a different fact for an operator, and the job id is in
      // provider_job_reference for anyone who wants to go and collect it.
      const exhaustedCode: TranscriptionErrorCode =
        err instanceof ProviderError && err.category === 'TIMEOUT'
          ? 'TRANSCRIPTION_TIMEOUT'
          : 'TRANSCRIPTION_EXHAUSTED_RETRIES';
      await this.archiveFailed(msgId, transcriptionJobId, exhaustedCode, detail);
      return;
    }

    await this.archiveFailed(msgId, transcriptionJobId, terminalCode, detail);
  }

  /**
   * Terminate a job, and never swallow a failed termination.
   *
   * The draft path learned this one expensively: an archive rejected by the
   * RPC's allowlist was logged and dropped, the message was neither archived
   * nor deleted, and it was redelivered until the delivery limit dead-lettered
   * it under the wrong code. Two escapes are provided so the job always
   * reaches a terminal state — a retry under a code the RPC cannot refuse, and
   * a delete for the case where there is nothing left to archive.
   */
  private async archiveFailed(
    msgId: bigint,
    transcriptionJobId: string,
    errorCode: TranscriptionErrorCode,
    providerDetail?: string
  ): Promise<void> {
    const { error } = await this.client.rpc('archive_transcription_failed_job', {
      p_msg_id: msgId.toString(),
      p_transcription_job_id: transcriptionJobId,
      p_error_code: errorCode,
      p_provider_error_detail: providerDetail ?? null,
    });

    if (!error) {
      return;
    }

    logger.error('Failed to archive transcription job', new Error(error.code || 'UNKNOWN'), {
      transcriptionJobId,
      queueMessageId: msgId.toString(),
      attemptedErrorCode: errorCode,
    });

    // P3I05: the job already completed or was skipped, so there is nothing to
    // dead-letter and no code that would help — the RPC checks status before
    // it checks the code. What is left is a stale queue message, and leaving
    // it queued means redelivering it forever.
    if (error.code === 'P3I05') {
      logger.info('Archive refused: job already finished. Discarding stale queue message', {
        transcriptionJobId,
        queueMessageId: msgId.toString(),
      });
      await this.queue.deleteJob(msgId);
      return;
    }

    if (errorCode === 'TRANSCRIPTION_INTERNAL_ERROR') {
      logger.error('Archive fallback also failed; job left on the queue', undefined, {
        transcriptionJobId,
        queueMessageId: msgId.toString(),
      });
      return;
    }

    const { error: fallbackError } = await this.client.rpc('archive_transcription_failed_job', {
      p_msg_id: msgId.toString(),
      p_transcription_job_id: transcriptionJobId,
      p_error_code: 'TRANSCRIPTION_INTERNAL_ERROR',
      p_provider_error_detail: providerDetail ?? `archive rejected for ${errorCode}`,
    });

    if (fallbackError) {
      logger.error(
        'Archive fallback also failed; job left on the queue',
        new Error(fallbackError.code || 'UNKNOWN'),
        { transcriptionJobId, queueMessageId: msgId.toString() }
      );
    } else {
      logger.info('Archived via TRANSCRIPTION_INTERNAL_ERROR after archive rejection', {
        transcriptionJobId,
        attemptedErrorCode: errorCode,
      });
    }
  }

  private async skipJob(
    transcriptionJobId: string,
    msgId: bigint,
    reason: TranscriptionSkipReason
  ): Promise<void> {
    const { error } = await this.client.rpc('skip_transcription_job', {
      p_transcription_job_id: transcriptionJobId,
      p_msg_id: msgId.toString(),
      p_skip_reason: reason,
    });

    if (error) {
      logger.error('Failed to skip transcription job', new Error(error.code || 'UNKNOWN'), {
        transcriptionJobId,
      });
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
