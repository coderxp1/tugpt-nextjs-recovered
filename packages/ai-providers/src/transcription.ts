/**
 * @file transcription.ts
 * @description Speech-to-text capability contract for TuGPT.
 *
 * WHY THIS IS A SEPARATE INTERFACE, NOT A WIDER `AIProviderAdapter`
 *
 * ADR-006 and `adapter.ts:6-15` both say that expanding `AIProviderAdapter`
 * beyond `generateCompletion` — to streaming, tool calls, embeddings, or
 * speech-to-text — requires a capability-based architecture review, and that
 * the contract must not grow by ad-hoc addition.
 *
 * Transcription is a different capability, not a wider completion. Bending it
 * into `generateCompletion` would mean a method whose `messages` parameter is
 * ignored, whose `temperature` is meaningless, and whose `usage` reports token
 * counts for a call that is billed by the second. Every consumer would then
 * have to know which kind of provider it was holding anyway — so the type
 * would be lying without saving anyone a branch.
 *
 * A provider may implement both interfaces. Nothing here widens the existing
 * contract, so ADR-006's review boundary stays where it is.
 */

/**
 * Where the audio lives.
 *
 * A URL rather than bytes: the async transcription APIs fetch the media
 * themselves, so for a URL the provider can reach, this avoids a copy through
 * the worker's memory. **The URL must be reachable by the provider** — stated
 * out loud here rather than discovered from a 4xx.
 *
 * WhatsApp media is NOT such a URL. Meta's Graph media endpoint is
 * Authorization-gated, so no third party can fetch it. That case goes through
 * {@link TranscriptionUploader} instead, and the sentence above is why: this
 * interface was written assuming a fetchable URL, and WhatsApp is the first
 * source that is not one.
 */
export interface AudioSource {
  readonly url: string;
  /** Optional MIME type, when the URL does not make it obvious. */
  readonly contentType?: string;
}

export interface TranscriptionOptions {
  readonly organizationId?: string;
  readonly requestId?: string;
  /**
   * Cancellation. Aborting stops both the submission and the polling loop and
   * surfaces as a `ProviderError` with category 'TIMEOUT'.
   *
   * Note that aborting does NOT cancel the provider's job. If submission has
   * already succeeded, the work is billed whether or not anyone reads the
   * result — see {@link TranscriptionProvider.transcribe}.
   */
  readonly signal?: AbortSignal;
  /** BCP-47 hint, e.g. 'es'. Providers treat this as a hint, not a constraint. */
  readonly languageHint?: string;
  /** How often to poll for a finished job. Provider default applies when unset. */
  readonly pollIntervalMs?: number;
  /** Ceiling on total wait before 'TIMEOUT'. Provider default applies when unset. */
  readonly maxWaitMs?: number;
}

/**
 * What the call will be billed for.
 *
 * `billingSeconds` and `audioSeconds` are two different numbers and the
 * difference matters. Gladia defines its billed quantity as
 * `audio_duration × number_of_distinct_channels`, so a stereo recording bills
 * twice its wall-clock length. A cost model that stored "seconds of audio" and
 * multiplied by the rate would understate every stereo file by 100%, and the
 * way you would find out is the invoice.
 *
 * So the rule, which generalises past Gladia: **record the quantity the
 * provider says it will bill, not the quantity we measured.** `billingSeconds`
 * is what reaches `record_provider_usage`; `audioSeconds` is kept beside it
 * because the difference between the two is exactly the thing worth being able
 * to see.
 */
export interface TranscriptionUsage {
  /** The provider's own billed quantity, in seconds. Authoritative for cost. */
  readonly billingSeconds: number;
  /** Wall-clock length of the audio, in seconds. Metadata, never priced. */
  readonly audioSeconds: number;
  /** Distinct channels the provider found. */
  readonly channels: number;
}

export interface TranscriptionResult {
  /** The provider's own id for the job. Required to match an invoice line. */
  readonly id: string;
  readonly provider: string;
  /** The model, when the provider names one. Transcription often does not. */
  readonly model: string | null;
  /**
   * The transcript.
   *
   * MAY BE EMPTY, and an empty transcript is not an error here. A silent or
   * inaudible voice note transcribes to nothing, and the provider bills for it
   * regardless. Throwing would lose the billing row for work that was really
   * performed, so the adapter reports faithfully and the decision about what
   * to do with an empty transcript belongs where drafts are enqueued — beside
   * the `body_text IS NOT NULL` gate that already makes exactly this call for
   * typed messages.
   */
  readonly text: string;
  /** Detected language, when the provider reports one. */
  readonly languageCode?: string;
  readonly usage: TranscriptionUsage;
  /** Wall-clock time this adapter spent, including polling. Not billed time. */
  readonly latencyMs: number;
}

/** A job the provider has accepted but not yet finished. */
export interface TranscriptionSubmission {
  /**
   * The provider's job id.
   *
   * PERSIST THIS BEFORE WAITING. Once submission succeeds the work is billed,
   * so a caller that loses the id and resubmits pays twice for one voice note.
   * The id is the idempotency handle: after a timeout, resume polling it —
   * never resubmit the audio.
   */
  readonly id: string;
  readonly provider: string;
}

export interface TranscriptionProvider {
  readonly providerName: string;

  /**
   * Hand the audio to the provider and return as soon as it is accepted.
   *
   * Separate from waiting because the two halves have different failure
   * consequences: a failed submission costs nothing, and a failed wait has
   * already been paid for.
   */
  submit(audio: AudioSource, options?: TranscriptionOptions): Promise<TranscriptionSubmission>;

  /** Poll an accepted job to completion. Safe to call repeatedly for one id. */
  awaitResult(id: string, options?: TranscriptionOptions): Promise<TranscriptionResult>;

  /**
   * `submit` then `awaitResult`.
   *
   * `onSubmitted` fires the moment the provider returns an id, before any
   * waiting. It exists so a caller can persist the id inside the same call —
   * without it, every timeout during polling loses the handle to work that has
   * already been billed, and the only available recovery is to pay again.
   * Anything it throws propagates, and deliberately so: if the id could not be
   * recorded, waiting for a result nobody can later resume is the worse
   * outcome.
   */
  transcribe(
    audio: AudioSource,
    options?: TranscriptionOptions & { readonly onSubmitted?: (id: string) => void | Promise<void> }
  ): Promise<TranscriptionResult>;
}

/**
 * Audio held in memory, for providers that accept an upload.
 *
 * `AudioSource` above says the provider fetches the URL itself, and for a URL
 * the provider can reach that is still the right shape. WhatsApp media is not
 * such a URL: Meta's Graph media endpoint requires an `Authorization` header
 * carrying our access token, so a third party given the URL receives a 401.
 * Handing Gladia that URL would be both broken and — if it ever worked —
 * a credential shared with a vendor that has no business holding one.
 *
 * So for WhatsApp the bytes transit the worker. That is a deliberate cost:
 * memory proportional to the file, which is why the download side enforces a
 * hard ceiling before and during the transfer rather than trusting a
 * Content-Length header.
 */
export interface AudioUpload {
  readonly bytes: Uint8Array;
  /** Used only for the multipart part name; providers infer format from bytes. */
  readonly filename: string;
  readonly contentType: string;
}

/**
 * A provider that can be handed bytes instead of a URL.
 *
 * Separate from {@link TranscriptionProvider} for the same reason
 * transcription is separate from completion: not every provider offers it, and
 * a method that throws 'unsupported' on half its implementations is a contract
 * that lies. `supportsAudioUpload` is the narrowing a caller uses.
 */
export interface TranscriptionUploader {
  /**
   * Upload audio and return the source to hand to `submit`/`transcribe`.
   *
   * Returns an {@link AudioSource} rather than a bare string so the two halves
   * compose without the caller reconstructing anything, and so a provider that
   * needs to carry a content type through can.
   *
   * NOT BILLED. An upload is storage, not transcription: nothing is charged
   * until the job is submitted. That asymmetry is why upload failures may be
   * retried freely and submission failures may not.
   */
  uploadAudio(audio: AudioUpload, options?: TranscriptionOptions): Promise<AudioSource>;
}

/** Narrows a provider to one that accepts uploads. */
export function supportsAudioUpload(
  provider: TranscriptionProvider
): provider is TranscriptionProvider & TranscriptionUploader {
  return typeof (provider as Partial<TranscriptionUploader>).uploadAudio === 'function';
}
