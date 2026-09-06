import { ProviderError, extractProviderDetail } from './errors';
import type {
  AudioSource,
  AudioUpload,
  TranscriptionOptions,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionSubmission,
  TranscriptionUploader,
} from './transcription';

/**
 * @file gladia.ts
 * @description Gladia.io async speech-to-text adapter.
 *
 * Implements `TranscriptionProvider` (see `transcription.ts` for why that is a
 * separate contract rather than a wider `AIProviderAdapter`).
 *
 * Gladia's pre-recorded API is a two-step async flow, with an optional upload
 * in front of it for audio Gladia cannot fetch itself:
 *
 *   POST /v2/upload            multipart 'audio' -> { audio_url }
 *   POST /v2/pre-recorded      { audio_url, … }  -> 201 { id, result_url }
 *   GET  /v2/pre-recorded/{id}                   -> { status, result?, error_code? }
 *                                                   status: queued|processing|done|error
 *
 * and on a finished job, `result.metadata` carries `audio_duration`,
 * `number_of_distinct_channels`, and `billing_time`.
 *
 * DISABLED BY DEFAULT. Nothing constructs this adapter unless the per-org
 * `voice_transcription` feature flag is on (migration 20260903000004), which
 * ships false everywhere.
 *
 * NO `metricsCollector.recordProviderCall` HERE, DELIBERATELY
 *
 * Every other adapter in this package emits that metric. Its shape is three
 * token counts plus latency, and a transcription call has no tokens — it is
 * billed by the second. Emitting one with `promptTokens: 0` three times over
 * would quietly drag down every "average tokens per call" panel that reads the
 * metric, turning a correct dashboard into a wrong one with no error anywhere.
 * The accounting that matters for this provider is `record_provider_usage`
 * (migration 20260903000002), which is modality-aware and stores seconds.
 */

/** Gladia's public API root. */
export const GLADIA_DEFAULT_BASE_URL = 'https://api.gladia.io';

/**
 * How often to ask whether a job has finished.
 *
 * Two seconds, because async transcription takes seconds to minutes and the
 * polling endpoint is rate-limited like any other. Faster polling does not
 * make the transcript arrive sooner; it only makes 429s more likely, and a 429
 * is fallback-eligible, so it would turn a working job into a retried one.
 */
export const GLADIA_DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Ceiling on the total wait, after which the adapter gives up polling.
 *
 * Five minutes. Not a guess at how long Gladia takes — a bound on how long one
 * worker slot may be held by one voice note. Hitting it does not mean the job
 * failed: the job is still running and still billed, which is why the timeout
 * path preserves the job id (see `transcribe`).
 */
export const GLADIA_DEFAULT_MAX_WAIT_MS = 300_000;

/**
 * Floor on a caller-supplied poll interval.
 *
 * A caller passing 0 would spin against a paid, rate-limited endpoint as fast
 * as the event loop allows. That is rejected rather than clamped: clamping
 * hides the mistake, and INVALID_CONFIGURATION is terminal, so a misconfigured
 * deployment fails once with the reason recorded instead of burning retries.
 */
export const GLADIA_MIN_POLL_INTERVAL_MS = 250;

export interface GladiaConfig {
  /** Sent as the `x-gladia-key` header. Gladia does not use Bearer auth. */
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

interface GladiaSubmitResponse {
  id?: unknown;
  result_url?: unknown;
}

interface GladiaUploadResponse {
  audio_url?: unknown;
  audio_metadata?: unknown;
}

interface GladiaPollResponse {
  id?: unknown;
  status?: unknown;
  error_code?: unknown;
  result?: {
    transcription?: { full_transcript?: unknown; languages?: unknown };
    metadata?: {
      audio_duration?: unknown;
      number_of_distinct_channels?: unknown;
      billing_time?: unknown;
    };
  };
}

const PROVIDER = 'gladia';

/** Finite, non-negative, and actually a number. */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** An abortable delay. Resolves after `ms`, rejects immediately on abort. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError(PROVIDER, 'TIMEOUT'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new ProviderError(PROVIDER, 'TIMEOUT'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class GladiaAdapter implements TranscriptionProvider, TranscriptionUploader {
  readonly providerName = PROVIDER;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(config: GladiaConfig) {
    if (!config.apiKey) {
      throw new ProviderError(
        PROVIDER,
        'INVALID_CONFIGURATION',
        undefined,
        'Gladia API key is empty. The key is read from platform_secrets, not the environment.'
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || GLADIA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.pollIntervalMs = this.checkedInterval(config.pollIntervalMs ?? GLADIA_DEFAULT_POLL_INTERVAL_MS);
    this.maxWaitMs = config.maxWaitMs ?? GLADIA_DEFAULT_MAX_WAIT_MS;
  }

  private checkedInterval(ms: number): number {
    if (!Number.isFinite(ms) || ms < GLADIA_MIN_POLL_INTERVAL_MS) {
      throw new ProviderError(
        PROVIDER,
        'INVALID_CONFIGURATION',
        undefined,
        `Poll interval ${ms}ms is below the ${GLADIA_MIN_POLL_INTERVAL_MS}ms floor.`
      );
    }
    return ms;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-gladia-key': this.apiKey };
  }

  /**
   * Headers for a multipart request: authentication only.
   *
   * Deliberately NOT `headers()` minus a field. `fetch` generates the
   * `multipart/form-data` Content-Type together with the boundary that
   * separates the parts; setting one by hand overrides it with a value that
   * has no boundary, and the server then reads the body as a single
   * unparseable blob. The failure is a 4xx that looks like a bad file.
   */
  private uploadHeaders(): Record<string, string> {
    return { 'x-gladia-key': this.apiKey };
  }

  /**
   * Turn anything thrown by `fetch` into the normalized taxonomy.
   *
   * Deliberately has no `err instanceof ProviderError` passthrough. The other
   * adapters carry one because their try block wraps the whole call including
   * their own throws; here it wraps the `fetch` alone, which cannot produce a
   * ProviderError, so that branch would be a line no test could reach. An
   * unreachable guard is the same failure it is meant to prevent, one level
   * up: it reads as protection and provides none.
   */
  private normalize(err: unknown): ProviderError {
    if (err instanceof Error && err.name === 'AbortError') {
      return new ProviderError(PROVIDER, 'TIMEOUT');
    }
    return new ProviderError(PROVIDER, 'NETWORK_FAILURE');
  }

  /** Read a provider's error body without letting that read mask the HTTP error. */
  private async detailOf(response: Response): Promise<string | undefined> {
    try {
      return extractProviderDetail(await response.text());
    } catch {
      return undefined;
    }
  }

  /**
   * POST /v2/upload — hand Gladia the bytes and get back a URL it can fetch.
   *
   * The URL returned is Gladia's own, on its storage, and is what `submit`
   * then takes. Two steps rather than one because Gladia's transcription
   * endpoint accepts only a URL; the upload is the adapter for sources the
   * provider cannot reach, which is every WhatsApp voice note.
   *
   * NOTHING IS BILLED HERE. Transcription is charged on submission, so an
   * upload that fails may be retried freely — which is why the worker's retry
   * budget is spent on the pair rather than on this alone.
   */
  async uploadAudio(audio: AudioUpload, options: TranscriptionOptions = {}): Promise<AudioSource> {
    if (audio.bytes.length === 0) {
      // An empty upload produces a job that transcribes nothing and is billed
      // for zero seconds — harmless in money, useless in outcome, and it
      // would land as a successful empty transcript, which reads to a
      // reviewer exactly like a genuinely silent recording. Refuse instead.
      throw new ProviderError(PROVIDER, 'INVALID_REQUEST', undefined, 'Audio upload is empty.');
    }

    const form = new FormData();
    // A fresh ArrayBuffer copy rather than a view onto the caller's buffer:
    // Blob accepts a view, and a view into a pooled Node Buffer can carry
    // bytes beyond its own window into the request body.
    const copy = new Uint8Array(audio.bytes.length);
    copy.set(audio.bytes);
    form.append('audio', new Blob([copy], { type: audio.contentType }), audio.filename);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v2/upload`, {
        method: 'POST',
        headers: this.uploadHeaders(),
        body: form,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      throw this.normalize(err);
    }

    if (!response.ok) {
      throw ProviderError.fromHttpStatus(PROVIDER, response.status, await this.detailOf(response));
    }

    let data: GladiaUploadResponse;
    try {
      data = (await response.json()) as GladiaUploadResponse;
    } catch {
      throw new ProviderError(
        PROVIDER,
        'MALFORMED_PROVIDER_RESPONSE',
        response.status,
        'Upload response was not JSON.'
      );
    }

    if (typeof data.audio_url !== 'string' || data.audio_url.length === 0) {
      throw new ProviderError(
        PROVIDER,
        'MALFORMED_PROVIDER_RESPONSE',
        response.status,
        'Upload succeeded but returned no audio_url.'
      );
    }

    return { url: data.audio_url, contentType: audio.contentType };
  }

  async submit(audio: AudioSource, options: TranscriptionOptions = {}): Promise<TranscriptionSubmission> {
    // Gladia fetches this URL server-side. Refusing a non-HTTP scheme before
    // the request costs nothing and keeps a misconfiguration from becoming a
    // request that asks a third party to open a local path.
    let parsed: URL;
    try {
      parsed = new URL(audio.url);
    } catch {
      throw new ProviderError(PROVIDER, 'INVALID_REQUEST', undefined, 'Audio URL is not a valid URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ProviderError(
        PROVIDER,
        'INVALID_REQUEST',
        undefined,
        `Audio URL scheme '${parsed.protocol}' is not http or https.`
      );
    }

    const body: Record<string, unknown> = { audio_url: audio.url };
    if (options.languageHint) {
      body.language_config = { languages: [options.languageHint] };
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v2/pre-recorded`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      throw this.normalize(err);
    }

    if (!response.ok) {
      throw ProviderError.fromHttpStatus(PROVIDER, response.status, await this.detailOf(response));
    }

    let data: GladiaSubmitResponse;
    try {
      data = (await response.json()) as GladiaSubmitResponse;
    } catch {
      throw new ProviderError(
        PROVIDER,
        'MALFORMED_PROVIDER_RESPONSE',
        response.status,
        'Submission response was not JSON.'
      );
    }

    if (typeof data.id !== 'string' || data.id.length === 0) {
      // Accepting a submission we cannot name means paying for work nobody can
      // ever collect. Terminal, and loudly so.
      throw new ProviderError(
        PROVIDER,
        'MALFORMED_PROVIDER_RESPONSE',
        response.status,
        'Submission succeeded but returned no job id.'
      );
    }

    return { id: data.id, provider: PROVIDER };
  }

  async awaitResult(id: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const interval = this.checkedInterval(options.pollIntervalMs ?? this.pollIntervalMs);
    const maxWait = options.maxWaitMs ?? this.maxWaitMs;

    for (;;) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/v2/pre-recorded/${encodeURIComponent(id)}`, {
          method: 'GET',
          headers: this.headers(),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (err) {
        throw this.normalize(err);
      }

      if (!response.ok) {
        throw ProviderError.fromHttpStatus(PROVIDER, response.status, await this.detailOf(response));
      }

      let data: GladiaPollResponse;
      try {
        data = (await response.json()) as GladiaPollResponse;
      } catch {
        throw new ProviderError(
          PROVIDER,
          'MALFORMED_PROVIDER_RESPONSE',
          response.status,
          'Poll response was not JSON.'
        );
      }

      const status = typeof data.status === 'string' ? data.status : undefined;

      if (status === 'done') {
        return this.mapResult(id, data, Date.now() - startedAt);
      }

      if (status === 'error') {
        // A job that finished in state 'error' is a different fact from a
        // polling request that failed, and the dead-letter record has to be
        // able to tell them apart — one means "the answer is: it failed", the
        // other means "I could not ask". Hence the prefix.
        const code = finiteNonNegative(data.error_code);
        const detail = `job failed: gladia error_code ${data.error_code ?? 'unreported'}`;
        throw code !== undefined && code >= 400 && code <= 599
          ? ProviderError.fromHttpStatus(PROVIDER, code, detail)
          : new ProviderError(PROVIDER, 'UNKNOWN_FAILURE', undefined, detail);
      }

      if (status !== 'queued' && status !== 'processing') {
        throw new ProviderError(
          PROVIDER,
          'MALFORMED_PROVIDER_RESPONSE',
          response.status,
          `Unrecognised job status '${String(data.status)}'.`
        );
      }

      // Check the budget before sleeping, so the ceiling is a ceiling on the
      // wait rather than on the wait plus one more interval.
      if (Date.now() - startedAt + interval > maxWait) {
        throw new ProviderError(
          PROVIDER,
          'TIMEOUT',
          undefined,
          `Job ${id} still ${status} after ${maxWait}ms; it is still running and still billed — resume polling this id, do not resubmit.`
        );
      }

      await delay(interval, options.signal);
    }
  }

  async transcribe(
    audio: AudioSource,
    options: TranscriptionOptions & { readonly onSubmitted?: (id: string) => void | Promise<void> } = {}
  ): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const submission = await this.submit(audio, options);

    // Before waiting, never after. Everything past this point is work the
    // provider has already accepted and will bill for, so a caller that cannot
    // name the job later has no recovery except paying again. If persisting
    // the id throws, that propagates: waiting for a result nobody can resume
    // is the worse outcome, and it is worse silently.
    if (options.onSubmitted) {
      await options.onSubmitted(submission.id);
    }

    const result = await this.awaitResult(submission.id, options);
    return { ...result, latencyMs: Date.now() - startedAt };
  }

  private mapResult(id: string, data: GladiaPollResponse, latencyMs: number): TranscriptionResult {
    const metadata = data.result?.metadata;

    // The one field this adapter refuses to guess at.
    //
    // Gladia defines billing_time as audio_duration × number_of_distinct_channels,
    // so falling back to audio_duration when it is missing would understate
    // every stereo recording by exactly 100% — and would do it silently, in a
    // number that reaches an invoice. A missing price is obvious; a wrong one
    // is plausible. So: refuse.
    const billingSeconds = finiteNonNegative(metadata?.billing_time);
    if (billingSeconds === undefined) {
      throw new ProviderError(
        PROVIDER,
        'MALFORMED_PROVIDER_RESPONSE',
        undefined,
        'Finished job reported no usable billing_time; refusing to substitute audio_duration.'
      );
    }

    const transcript = data.result?.transcription?.full_transcript;
    if (transcript !== undefined && typeof transcript !== 'string') {
      throw new ProviderError(
        PROVIDER,
        'MALFORMED_PROVIDER_RESPONSE',
        undefined,
        'Finished job reported a non-string transcript.'
      );
    }

    const languages = data.result?.transcription?.languages;
    const languageCode =
      Array.isArray(languages) && typeof languages[0] === 'string' ? (languages[0] as string) : undefined;

    return {
      id,
      provider: PROVIDER,
      // Gladia names no model on the pre-recorded endpoint. Null says "the
      // provider did not report one"; a placeholder string would end up in
      // provider_usage_events looking like a real model name.
      model: null,
      // An empty transcript is a real outcome for a silent recording, and it
      // was still billed — see TranscriptionResult.text.
      text: typeof transcript === 'string' ? transcript : '',
      ...(languageCode ? { languageCode } : {}),
      usage: {
        billingSeconds,
        // Metadata only. Zero means "not reported"; neither of these is ever
        // priced, so a zero here cannot cost anyone money.
        audioSeconds: finiteNonNegative(metadata?.audio_duration) ?? 0,
        channels: finiteNonNegative(metadata?.number_of_distinct_channels) ?? 0,
      },
      latencyMs,
    };
  }
}
