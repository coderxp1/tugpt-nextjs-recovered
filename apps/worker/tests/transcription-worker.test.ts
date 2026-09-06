import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ProviderError } from '@tugpt/ai-providers';
import { TranscriptionWorker } from '../src/transcription-worker';
import { MediaFetchError, type WhatsAppMediaClient } from '../src/whatsapp-media';
import {
  createMockClient,
  mockResult,
  rpcCall,
  rpcNames,
  MOCK_JOB_ID,
  MOCK_JOB_ROW,
  MOCK_MSG_ID,
  MOCK_ORG_ID,
  MOCK_SOURCE_MESSAGE_ID,
  MOCK_MEDIA_REFERENCE,
  MOCK_PROVIDER_JOB_ID,
  MOCK_QUEUE_MESSAGE,
  MOCK_TRANSCRIPT,
  MOCK_AUDIO,
  MOCK_USAGE,
} from './fixtures/transcription-fixtures';

/**
 * ===========================================================================
 * WHAT THIS FILE IS DEFENDING
 * ===========================================================================
 *
 * Gladia bills on submission. So the assertions here are ordered by how much a
 * regression would cost, not by the order the code runs in:
 *
 *   1. **Paying twice for one voice note.** A job that already carries a
 *      provider job reference must be RESUMED, never resubmitted — no
 *      download, no upload, no submit. Group R. This is the single most
 *      expensive mistake available in this file, and every assertion in that
 *      group is paired with a positive control showing the fresh path DOES
 *      download and submit on the same fixtures.
 *
 *   2. **Losing the handle to work already paid for.** The provider's job id
 *      is persisted through `onSubmitted`, before any polling, and a failure
 *      to persist it must abort rather than wait. Group S.
 *
 *   3. **Spending when we were told not to.** Either flag off means skip, and
 *      skip means no download, no upload, no submission. Group F.
 *
 *   4. **Recording the wrong number.** `billingSeconds` is duration times
 *      channels; recording `audioSeconds` instead understates every stereo
 *      recording by exactly 100%, and the way anyone would find out is the
 *      invoice. Group U — with a fractional, asymmetric fixture so that
 *      recording the wrong field, or rounding the wrong way, both fail.
 *
 *   5. **Content in logs.** Group P scans everything the worker logged for the
 *      transcript, the media reference and the audio bytes.
 */

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  worker: TranscriptionWorker;
  client: SupabaseClient;
  provider: {
    providerName: string;
    uploadAudio: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    awaitResult: ReturnType<typeof vi.fn>;
    transcribe: ReturnType<typeof vi.fn>;
  };
  media: { fetchAudio: ReturnType<typeof vi.fn> };
  buildDeps: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  jobRow?: Record<string, unknown> | null;
  flags?: Record<string, boolean>;
  flagLookupFails?: boolean;
  rpc?: Record<string, { data?: unknown; error?: { code: string; message: string } | null }>;
  /** What `transcribe` does. Default: fire onSubmitted, then resolve. */
  transcribe?: (audio: unknown, options: Record<string, unknown>) => Promise<unknown>;
  awaitResult?: () => Promise<unknown>;
  uploadAudio?: () => Promise<unknown>;
  fetchAudio?: () => Promise<unknown>;
  depsError?: unknown;
  /** Drop `uploadAudio` entirely, to model a URL-only provider. */
  urlOnlyProvider?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const client = createMockClient({
    jobRow: options.jobRow === undefined ? MOCK_JOB_ROW : options.jobRow,
    flags: options.flags,
    ...(options.flagLookupFails ? { flagLookupFails: true } : {}),
    rpc: {
      delete_transcription_job: { data: true },
      set_transcription_visibility: { data: true },
      skip_transcription_job: { data: true },
      record_transcription_submission: { data: null },
      complete_transcription_job: { data: [{ message_id: MOCK_SOURCE_MESSAGE_ID, draft_enqueued: true }] },
      record_provider_usage: { data: 'usage-event-1' },
      archive_transcription_failed_job: { data: [{ archived: true, already_archived: false }] },
      ...options.rpc,
    },
  });

  const provider = {
    providerName: 'gladia',
    uploadAudio: vi.fn(
      options.uploadAudio ?? (async () => ({ url: 'https://gladia.example/u/x.ogg' }))
    ),
    submit: vi.fn(async () => ({ id: MOCK_PROVIDER_JOB_ID, provider: 'gladia' })),
    awaitResult: vi.fn(options.awaitResult ?? (async () => mockResult())),
    transcribe: vi.fn(
      options.transcribe ??
        (async (_audio: unknown, opts: Record<string, unknown>) => {
          const onSubmitted = opts.onSubmitted as ((id: string) => Promise<void>) | undefined;
          if (onSubmitted) await onSubmitted(MOCK_PROVIDER_JOB_ID);
          return mockResult();
        })
    ),
  };

  if (options.urlOnlyProvider) {
    delete (provider as Partial<typeof provider>).uploadAudio;
  }

  const media = {
    fetchAudio: vi.fn(
      options.fetchAudio ??
        (async () => ({
          bytes: MOCK_AUDIO,
          mimeType: 'audio/ogg',
          sha256: 'a'.repeat(64),
        }))
    ),
  };

  const buildDeps = vi.fn(async () => {
    if (options.depsError) throw options.depsError;
    return { provider, media: media as unknown as WhatsAppMediaClient };
  });

  const worker = new TranscriptionWorker(client, buildDeps as never, {
    pollIntervalMs: 10,
    visibilityTimeoutSeconds: 120,
  });

  return { worker, client, provider, media, buildDeps };
}

function process(
  h: Harness,
  message: Record<string, unknown> = MOCK_QUEUE_MESSAGE
): Promise<void> {
  return (
    h.worker as unknown as {
      processJob: (job: unknown, signal: AbortSignal) => Promise<void>;
    }
  ).processJob(message, new AbortController().signal);
}

// ===========================================================================
// L: the lifecycle
// ===========================================================================

describe('TranscriptionWorker — lifecycle', () => {
  it('downloads, uploads, transcribes, stores, records and deletes, in that order', async () => {
    const h = harness();
    await process(h);

    expect(h.media.fetchAudio).toHaveBeenCalledWith(
      MOCK_MEDIA_REFERENCE,
      expect.anything()
    );
    expect(h.provider.uploadAudio).toHaveBeenCalledOnce();
    expect(h.provider.transcribe).toHaveBeenCalledOnce();

    const names = rpcNames(h.client);
    expect(names).toContain('complete_transcription_job');
    expect(names).toContain('record_provider_usage');
    expect(names).toContain('delete_transcription_job');

    // The transcript is the customer-visible work and must not be undone by a
    // bookkeeping failure, and the queue message must not be deleted before
    // the transcript is stored.
    expect(names.indexOf('complete_transcription_job')).toBeLessThan(
      names.indexOf('record_provider_usage')
    );
    expect(names.indexOf('record_provider_usage')).toBeLessThan(
      names.indexOf('delete_transcription_job')
    );
  });

  it('uploads exactly the bytes the media client produced', async () => {
    const h = harness();
    await process(h);

    expect(h.provider.uploadAudio.mock.calls[0][0]).toMatchObject({
      bytes: MOCK_AUDIO,
      contentType: MOCK_JOB_ROW.media_mime_type,
    });
  });

  it('transcribes the source the upload returned, not the WhatsApp media reference', async () => {
    const h = harness();
    await process(h);

    // Handing Gladia the Meta URL would be both broken (it is
    // Authorization-gated) and a credential shared with a vendor.
    expect(h.provider.transcribe.mock.calls[0][0]).toEqual({
      url: 'https://gladia.example/u/x.ogg',
    });
  });

  it('stores the transcript, the provider job id and the detected language', async () => {
    const h = harness();
    await process(h);

    expect(rpcCall(h.client, 'complete_transcription_job')).toMatchObject({
      p_job_id: MOCK_JOB_ID,
      p_transcript: MOCK_TRANSCRIPT,
      p_provider: 'gladia',
      p_provider_job_reference: MOCK_PROVIDER_JOB_ID,
      p_language_code: 'es',
    });
  });

  it('passes a null language rather than omitting it when none was detected', async () => {
    const h = harness({
      transcribe: async (_a, opts) => {
        await (opts.onSubmitted as (id: string) => Promise<void>)(MOCK_PROVIDER_JOB_ID);
        return mockResult({ languageCode: undefined });
      },
    });
    await process(h);

    expect(rpcCall(h.client, 'complete_transcription_job')!.p_language_code).toBeNull();
  });

  /**
   * An empty transcript is a real outcome for a silent recording, and it was
   * still billed. Completing the job (rather than failing it) is what keeps
   * the usage row; the decision not to enqueue a draft belongs to the RPC.
   */
  it('completes normally on an empty transcript rather than treating it as a failure', async () => {
    const h = harness({
      transcribe: async (_a, opts) => {
        await (opts.onSubmitted as (id: string) => Promise<void>)(MOCK_PROVIDER_JOB_ID);
        return mockResult({ text: '' });
      },
    });
    await process(h);

    expect(rpcCall(h.client, 'complete_transcription_job')!.p_transcript).toBe('');
    expect(rpcNames(h.client)).toContain('record_provider_usage');
    expect(rpcNames(h.client)).not.toContain('archive_transcription_failed_job');
  });
});

// ===========================================================================
// R: resume, never resubmit
// ===========================================================================

describe('TranscriptionWorker — a job already submitted is resumed', () => {
  const submitted = { ...MOCK_JOB_ROW, provider_job_reference: MOCK_PROVIDER_JOB_ID };

  it('polls the existing provider job instead of transcribing again', async () => {
    const h = harness({ jobRow: submitted });
    await process(h);

    expect(h.provider.awaitResult).toHaveBeenCalledWith(
      MOCK_PROVIDER_JOB_ID,
      expect.anything()
    );
    expect(h.provider.transcribe).not.toHaveBeenCalled();
  });

  it('does not download the media again', async () => {
    const h = harness({ jobRow: submitted });
    await process(h);
    expect(h.media.fetchAudio).not.toHaveBeenCalled();
  });

  it('does not upload the audio again', async () => {
    const h = harness({ jobRow: submitted });
    await process(h);
    expect(h.provider.uploadAudio).not.toHaveBeenCalled();
  });

  /**
   * The control for the three above. Without it, "did not download" would be
   * satisfied by a worker that never downloads at all.
   */
  it('control: the same fixtures WITHOUT a reference do download, upload and submit', async () => {
    const h = harness({ jobRow: { ...MOCK_JOB_ROW, provider_job_reference: null } });
    await process(h);

    expect(h.media.fetchAudio).toHaveBeenCalledOnce();
    expect(h.provider.uploadAudio).toHaveBeenCalledOnce();
    expect(h.provider.transcribe).toHaveBeenCalledOnce();
    expect(h.provider.awaitResult).not.toHaveBeenCalled();
  });

  it('stores the transcript a resumed job produced, like any other', async () => {
    const h = harness({ jobRow: submitted });
    await process(h);

    expect(rpcCall(h.client, 'complete_transcription_job')).toMatchObject({
      p_transcript: MOCK_TRANSCRIPT,
    });
  });
});

// ===========================================================================
// S: the handle to billed work
// ===========================================================================

describe('TranscriptionWorker — recording the submission', () => {
  it('records the provider job id through onSubmitted', async () => {
    const h = harness();
    await process(h);

    expect(rpcCall(h.client, 'record_transcription_submission')).toEqual({
      p_job_id: MOCK_JOB_ID,
      p_provider: 'gladia',
      p_provider_job_reference: MOCK_PROVIDER_JOB_ID,
    });
  });

  /**
   * The adapter's contract is that anything `onSubmitted` throws propagates
   * before it starts waiting, and that is the behaviour wanted: a handle we
   * could not store is work we cannot resume, so the honest move is to fail
   * loudly rather than wait for a result nobody can collect later.
   */
  it('propagates a failure to record it, rather than waiting anyway', async () => {
    const h = harness({
      rpc: { record_transcription_submission: { error: { code: 'P3I08', message: 'x' } } },
      transcribe: async (_a, opts) => {
        // A faithful stand-in for the real adapter: onSubmitted first, and
        // whatever it throws is not caught.
        await (opts.onSubmitted as (id: string) => Promise<void>)(MOCK_PROVIDER_JOB_ID);
        return mockResult();
      },
    });

    await process(h);

    // The attempt failed, so nothing was completed. read_ct is 1, so it backs
    // off rather than dead-lettering.
    expect(rpcNames(h.client)).not.toContain('complete_transcription_job');
    expect(rpcNames(h.client)).toContain('set_transcription_visibility');
  });
});

// ===========================================================================
// F: the flags
// ===========================================================================

describe('TranscriptionWorker — feature gates', () => {
  it('skips, and spends nothing, when voice_transcription is off', async () => {
    const h = harness({ flags: { voice_transcription: false } });
    await process(h);

    expect(rpcCall(h.client, 'skip_transcription_job')).toMatchObject({
      p_transcription_job_id: MOCK_JOB_ID,
      p_skip_reason: 'FEATURE_DISABLED',
    });
    expect(h.media.fetchAudio).not.toHaveBeenCalled();
    expect(h.provider.uploadAudio).not.toHaveBeenCalled();
    expect(h.provider.transcribe).not.toHaveBeenCalled();
  });

  /**
   * Mirrors the enqueue gate in migration 20260903000008, which reads both
   * flags: transcribing a voice note nobody will draft from is paying to
   * produce a row no reviewer acts on. The distinct reason is what tells an
   * operator which switch to flip.
   */
  it('skips with a different reason when ai_draft_generation is off', async () => {
    const h = harness({ flags: { ai_draft_generation: false } });
    await process(h);

    expect(rpcCall(h.client, 'skip_transcription_job')!.p_skip_reason).toBe('DRAFT_DISABLED');
    expect(h.provider.transcribe).not.toHaveBeenCalled();
  });

  it('control: with both flags on, the same fixture transcribes', async () => {
    const h = harness({ flags: { voice_transcription: true, ai_draft_generation: true } });
    await process(h);

    expect(rpcNames(h.client)).not.toContain('skip_transcription_job');
    expect(h.provider.transcribe).toHaveBeenCalledOnce();
  });

  /**
   * FAIL CLOSED. "The answer was no" and "there was no answer" are different
   * facts, and the worker must treat the second as the first: a flag lookup
   * that failed is not permission to spend money on a provider call.
   *
   * A mutation that made the error branch return `true` survived every other
   * assertion in this file, because the mock always answered successfully.
   * This is the assertion that kills it.
   */
  it('spends nothing when the flag lookup itself fails', async () => {
    const h = harness({ flagLookupFails: true });
    await process(h);

    expect(rpcCall(h.client, 'skip_transcription_job')!.p_skip_reason).toBe('FEATURE_DISABLED');
    expect(h.media.fetchAudio).not.toHaveBeenCalled();
    expect(h.provider.uploadAudio).not.toHaveBeenCalled();
    expect(h.provider.transcribe).not.toHaveBeenCalled();
    expect(h.buildDeps).not.toHaveBeenCalled();
  });

  it('does not build the credentialed clients for a job it is going to skip', async () => {
    const h = harness({ flags: { voice_transcription: false } });
    await process(h);
    expect(h.buildDeps).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// U: the billed quantity
// ===========================================================================

describe('TranscriptionWorker — usage accounting', () => {
  /**
   * `billingSeconds` (24.3) is Gladia's own billed quantity — duration times
   * channels. `audioSeconds` (12.15) is the wall-clock length. Recording the
   * second would understate every stereo recording by exactly 100%, and the
   * way anyone would find out is the invoice.
   */
  it('records the provider\'s billed seconds, not the wall-clock length', async () => {
    const h = harness();
    await process(h);

    expect(rpcCall(h.client, 'record_provider_usage')!.p_quantities).toEqual({
      audio_seconds: 25,
    });
  });

  // Rounding on a cost is a choice, and under-reporting spend is the wrong one.
  it('rounds the billed seconds up', async () => {
    const h = harness({
      transcribe: async (_a, opts) => {
        await (opts.onSubmitted as (id: string) => Promise<void>)(MOCK_PROVIDER_JOB_ID);
        return mockResult({ usage: { ...MOCK_USAGE, billingSeconds: 0.2 } });
      },
    });
    await process(h);

    expect(rpcCall(h.client, 'record_provider_usage')!.p_quantities).toEqual({ audio_seconds: 1 });
  });

  it('records it against audio, the organization and the source message', async () => {
    const h = harness();
    await process(h);

    expect(rpcCall(h.client, 'record_provider_usage')).toMatchObject({
      p_modality: 'audio',
      p_organization_id: MOCK_ORG_ID,
      p_message_id: MOCK_SOURCE_MESSAGE_ID,
      p_provider_reference: MOCK_PROVIDER_JOB_ID,
      p_draft_generation_job_id: null,
    });
  });

  // The gap between billed and measured is exactly the thing worth being able
  // to see later, so it is kept beside the priced number rather than dropped.
  it('keeps the unpriced duration and channel count as metadata', async () => {
    const h = harness();
    await process(h);

    expect(rpcCall(h.client, 'record_provider_usage')!.p_metadata).toMatchObject({
      audio_duration_seconds: MOCK_USAGE.audioSeconds,
      channels: MOCK_USAGE.channels,
    });
  });

  it('writes no usage row when the provider reported nothing billable', async () => {
    const h = harness({
      transcribe: async (_a, opts) => {
        await (opts.onSubmitted as (id: string) => Promise<void>)(MOCK_PROVIDER_JOB_ID);
        return mockResult({ usage: { billingSeconds: 0, audioSeconds: 0, channels: 0 } });
      },
    });
    await process(h);

    expect(rpcNames(h.client)).not.toContain('record_provider_usage');
    // Still completed and still removed from the queue: the transcript exists.
    expect(rpcNames(h.client)).toContain('complete_transcription_job');
    expect(rpcNames(h.client)).toContain('delete_transcription_job');
  });

  /**
   * By the time this runs the transcript is stored and Gladia has already
   * charged. Failing the job here would retry work that is finished.
   */
  it('does not fail the job when the usage write fails', async () => {
    const h = harness({
      rpc: { record_provider_usage: { error: { code: 'P3G01', message: 'no price' } } },
    });
    await process(h);

    expect(rpcNames(h.client)).toContain('delete_transcription_job');
    expect(rpcNames(h.client)).not.toContain('archive_transcription_failed_job');
  });
});

// ===========================================================================
// E: failure handling
// ===========================================================================

describe('TranscriptionWorker — transient failures', () => {
  it.each([
    ['a 5xx from Meta', () => new MediaFetchError('MEDIA_TRANSIENT', 'down')],
    ['a truncated download', () => new MediaFetchError('MEDIA_INTEGRITY', 'digest mismatch')],
  ])('backs off rather than dead-lettering on %s', async (_label, make) => {
    const h = harness({ fetchAudio: async () => { throw make(); } });
    await process(h);

    expect(rpcNames(h.client)).toContain('set_transcription_visibility');
    expect(rpcNames(h.client)).not.toContain('archive_transcription_failed_job');
  });

  it('backs off on a transient provider failure', async () => {
    const h = harness({ uploadAudio: async () => { throw new ProviderError('gladia', 'HTTP_5XX', 503); } });
    await process(h);

    expect(rpcNames(h.client)).toContain('set_transcription_visibility');
  });

  it('backs off further on the second attempt than the first', async () => {
    const first = harness({ fetchAudio: async () => { throw new MediaFetchError('MEDIA_TRANSIENT'); } });
    await process(first, { ...MOCK_QUEUE_MESSAGE, readCt: 1 });

    const second = harness({ fetchAudio: async () => { throw new MediaFetchError('MEDIA_TRANSIENT'); } });
    await process(second, { ...MOCK_QUEUE_MESSAGE, readCt: 2 });

    const d1 = rpcCall(first.client, 'set_transcription_visibility')!
      .p_visibility_timeout_seconds as number;
    const d2 = rpcCall(second.client, 'set_transcription_visibility')!
      .p_visibility_timeout_seconds as number;

    expect(d2).toBeGreaterThan(d1);
  });

  it('archives on the third transient failure instead of retrying forever', async () => {
    const h = harness({ fetchAudio: async () => { throw new MediaFetchError('MEDIA_TRANSIENT'); } });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 3 });

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_error_code).toBe(
      'TRANSCRIPTION_EXHAUSTED_RETRIES'
    );
    expect(rpcNames(h.client)).not.toContain('set_transcription_visibility');
  });

  /**
   * The one exhausted-retry case that keeps its own code. "We stopped waiting
   * for work that was billed" is a different fact for an operator than "three
   * attempts failed" — and the job id is in provider_job_reference for anyone
   * who wants to go and collect the result.
   */
  it('archives an exhausted provider TIMEOUT as TRANSCRIPTION_TIMEOUT', async () => {
    const h = harness({
      jobRow: { ...MOCK_JOB_ROW, provider_job_reference: MOCK_PROVIDER_JOB_ID },
      awaitResult: async () => { throw new ProviderError('gladia', 'TIMEOUT', undefined, 'still processing'); },
    });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 3 });

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_error_code).toBe(
      'TRANSCRIPTION_TIMEOUT'
    );
  });

  it('backs off on an unexpected internal error rather than dead-lettering a voice note', async () => {
    const h = harness({ fetchAudio: async () => { throw new Error('socket hang up'); } });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 1 });

    expect(rpcNames(h.client)).toContain('set_transcription_visibility');
  });
});

describe('TranscriptionWorker — terminal failures', () => {
  it.each([
    ['MEDIA_TOO_LARGE', 'TRANSCRIPTION_MEDIA_TOO_LARGE'],
    ['MEDIA_UNAVAILABLE', 'TRANSCRIPTION_MEDIA_UNAVAILABLE'],
    ['MEDIA_MALFORMED', 'TRANSCRIPTION_MEDIA_UNAVAILABLE'],
    ['MEDIA_AUTH_ERROR', 'TRANSCRIPTION_MEDIA_AUTH_ERROR'],
  ])('archives %s as %s on the FIRST attempt', async (mediaCode, expected) => {
    const h = harness({
      fetchAudio: async () => { throw new MediaFetchError(mediaCode as never, 'detail'); },
    });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 1 });

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_error_code).toBe(expected);
    expect(rpcNames(h.client)).not.toContain('set_transcription_visibility');

    // The point of terminating at the media stage: the provider is never
    // reached, so nothing is billed for a file that was refused.
    expect(h.provider.uploadAudio).not.toHaveBeenCalled();
    expect(h.provider.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP_401', 'TRANSCRIPTION_PROVIDER_AUTH_ERROR'],
    ['HTTP_400', 'TRANSCRIPTION_PROVIDER_ERROR'],
    ['MALFORMED_PROVIDER_RESPONSE', 'TRANSCRIPTION_MALFORMED_RESPONSE'],
    ['INVALID_CONFIGURATION', 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR'],
  ])('archives a provider %s as %s on the first attempt', async (category, expected) => {
    const h = harness({
      uploadAudio: async () => { throw new ProviderError('gladia', category as never, 401, 'bad'); },
    });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 1 });

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_error_code).toBe(expected);
  });

  it('carries the sanitized provider detail onto the dead-letter record', async () => {
    const h = harness({
      uploadAudio: async () => { throw new ProviderError('gladia', 'HTTP_400', 400, 'audio too short'); },
    });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 1 });

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_provider_error_detail).toBe(
      'audio too short'
    );
  });

  /**
   * The 2026-08-19 shape, in the new path. An archive the RPC refuses must not
   * be logged and dropped — that leaves the message on the queue to be
   * redelivered until the delivery limit dead-letters it under a code that
   * describes the wrong thing.
   */
  it('retries a refused archive under the code the RPC cannot refuse', async () => {
    let call = 0;
    const client = createMockClient({
      jobRow: MOCK_JOB_ROW,
      rpc: {
        set_transcription_visibility: { data: true },
        delete_transcription_job: { data: true },
      },
    });
    const original = (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;
    (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn(
      async (name: string, params: Record<string, unknown>) => {
        if (name === 'archive_transcription_failed_job') {
          call += 1;
          if (call === 1) return { data: null, error: { code: 'P3I06', message: 'bad code' } };
          return { data: [{ archived: true, already_archived: false }], error: null };
        }
        return original(name, params);
      }
    );

    const worker = new TranscriptionWorker(
      client,
      (async () => ({
        provider: {
          providerName: 'gladia',
          uploadAudio: async () => { throw new ProviderError('gladia', 'HTTP_400', 400); },
          submit: async () => ({ id: 'x', provider: 'gladia' }),
          awaitResult: async () => mockResult(),
          transcribe: async () => mockResult(),
        },
        media: { fetchAudio: async () => ({ bytes: MOCK_AUDIO, mimeType: 'audio/ogg', sha256: 'a' }) },
      })) as never,
      { pollIntervalMs: 10, visibilityTimeoutSeconds: 120 }
    );

    await (worker as unknown as { processJob: (j: unknown, s: AbortSignal) => Promise<void> })
      .processJob({ ...MOCK_QUEUE_MESSAGE, readCt: 1 }, new AbortController().signal);

    const archives = (client as unknown as { rpc: { mock: { calls: Array<[string, Record<string, unknown>]> } } })
      .rpc.mock.calls.filter(([n]) => n === 'archive_transcription_failed_job');
    expect(archives).toHaveLength(2);
    expect(archives[1][1].p_error_code).toBe('TRANSCRIPTION_INTERNAL_ERROR');
  });

  it('discards the stale queue message when the archive says the job already finished', async () => {
    const h = harness({
      rpc: {
        archive_transcription_failed_job: { error: { code: 'P3I05', message: 'already finished' } },
      },
      uploadAudio: async () => { throw new ProviderError('gladia', 'HTTP_400', 400); },
    });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 1 });

    expect(rpcNames(h.client)).toContain('delete_transcription_job');
  });
});

describe('TranscriptionWorker — missing credentials', () => {
  it('archives with the Gladia-specific code when the vault has no Gladia key', async () => {
    const h = harness({
      depsError: new ProviderError('gladia', 'INVALID_CONFIGURATION', undefined, 'no gladia/api_key row'),
    });
    await process(h);

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_error_code).toBe(
      'TRANSCRIPTION_PROVIDER_CONFIG_ERROR'
    );
  });

  // Two credentials, two operator actions: put a Gladia key in the vault, or
  // fix the Meta Graph token. One code would say "authentication problem" and
  // leave the operator to find out which.
  it('archives with the Meta-specific code when the vault has no Graph token', async () => {
    const h = harness({ depsError: new MediaFetchError('MEDIA_AUTH_ERROR', 'no meta row') });
    await process(h);

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_error_code).toBe(
      'TRANSCRIPTION_MEDIA_AUTH_ERROR'
    );
  });

  it('spends nothing on a job whose credentials could not be built', async () => {
    const h = harness({ depsError: new Error('vault unreachable') });
    await process(h);

    expect(h.media.fetchAudio).not.toHaveBeenCalled();
    expect(h.provider.transcribe).not.toHaveBeenCalled();
  });
});

describe('TranscriptionWorker — provider capability', () => {
  /**
   * Not a runtime accident. WhatsApp media URLs are Authorization-gated, so a
   * provider that can only fetch a URL cannot transcribe them at all — and
   * handing it the URL anyway would produce a 401 reported as a provider
   * error, sending the reader to look at the Gladia key.
   */
  it('fails as a configuration error when the provider cannot take an upload', async () => {
    const h = harness({ urlOnlyProvider: true });
    await process(h, { ...MOCK_QUEUE_MESSAGE, readCt: 1 });

    expect(rpcCall(h.client, 'archive_transcription_failed_job')!.p_error_code).toBe(
      'TRANSCRIPTION_PROVIDER_CONFIG_ERROR'
    );
    expect(h.media.fetchAudio).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// M: messages that name nothing
// ===========================================================================

describe('TranscriptionWorker — unusable queue messages', () => {
  it('deletes a message with no job id rather than looping on it forever', async () => {
    const h = harness();
    await process(h, { msgId: MOCK_MSG_ID, readCt: 1, payload: { requestId: 'x' } });

    expect(rpcNames(h.client)).toContain('delete_transcription_job');
    expect(rpcNames(h.client)).not.toContain('archive_transcription_failed_job');
  });

  it('deletes a message whose job row is gone', async () => {
    const h = harness({ jobRow: null });
    await process(h);

    expect(rpcNames(h.client)).toContain('delete_transcription_job');
    expect(h.buildDeps).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// P: privacy
// ===========================================================================

describe('TranscriptionWorker — what reaches the logs', () => {
  it('never logs the transcript, the media reference or the audio bytes', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      })
    );

    try {
      const h = harness();
      await process(h);
      await flushMicrotasks();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    const all = lines.join('\n');
    expect(all).not.toContain(MOCK_TRANSCRIPT);
    expect(all).not.toContain(MOCK_MEDIA_REFERENCE);
    expect(all).not.toContain(Buffer.from(MOCK_AUDIO).toString('base64'));
  });

  // The control: the logger really was capturing, so the assertions above are
  // about absence rather than about an empty array.
  it('control: it does log the job id, so the scan above ran against real output', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });

    try {
      const h = harness();
      await process(h);
      await flushMicrotasks();
    } finally {
      spy.mockRestore();
      infoSpy.mockRestore();
    }

    expect(lines.join('\n')).toContain(MOCK_JOB_ID);
  });
});
