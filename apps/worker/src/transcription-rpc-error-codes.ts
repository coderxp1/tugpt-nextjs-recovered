import type { ProviderErrorCategory } from '@tugpt/ai-providers';
import type { MediaErrorCode } from './whatsapp-media.js';

/**
 * @file transcription-rpc-error-codes.ts
 * @description The vocabulary the transcription worker may hand the database,
 * and the rules that turn a failure into one of those words.
 *
 * ===========================================================================
 * WHY THIS FILE IS NOT OPTIONAL
 * ===========================================================================
 *
 * The archive RPC has its own allowlist. On 2026-08-19 the draft worker
 * produced eight terminal codes while its RPC accepted five, so every terminal
 * failure was rejected, logged, and dropped; the message was redelivered until
 * the delivery limit dead-lettered it as DRAFT_EXHAUSTED_RETRIES. A Langdock
 * 400 presented as three exhausted retries with the provider's actual
 * complaint recorded nowhere.
 *
 * `TranscriptionErrorCode` below is therefore the SAME list as the allowlist
 * in migration 20260905000001, and `transcription-rpc-error-codes.test.ts`
 * reads the migration file and fails if the two drift.
 *
 * ===========================================================================
 * TRANSIENT VERSUS TERMINAL, AND WHY IT IS ABOUT MONEY HERE
 * ===========================================================================
 *
 * For draft generation this split is about latency. For transcription it is
 * about spend: Gladia bills on submission, so a retry that resubmits is a
 * second charge for one voice note. Three consequences, all encoded here:
 *
 *   * Media failures are cheap to retry (nothing is billed for a download) but
 *     most of them are terminal anyway, because a file does not shrink and a
 *     media id Meta refuses does not start being served. Retrying reaches the
 *     same answer three times.
 *
 *   * A truncated download IS worth retrying — nothing was billed and the next
 *     attempt may well succeed — so MEDIA_INTEGRITY is transient. This is the
 *     one case where "the data was wrong" means "ask again".
 *
 *   * A provider TIMEOUT is transient, but retrying it must RESUME the
 *     existing job rather than submit a new one. That rule lives in the worker
 *     (it is what `provider_job_reference` is for); what lives here is the
 *     terminal code it gets when the resumption itself runs out of attempts —
 *     TRANSCRIPTION_TIMEOUT rather than TRANSCRIPTION_EXHAUSTED_RETRIES,
 *     because "we stopped waiting for work that was billed" is a different
 *     fact for an operator than "three attempts failed".
 */

export type TranscriptionErrorCode =
  | 'TRANSCRIPTION_EXHAUSTED_RETRIES'
  | 'TRANSCRIPTION_MEDIA_TOO_LARGE'
  | 'TRANSCRIPTION_MEDIA_UNAVAILABLE'
  | 'TRANSCRIPTION_MEDIA_AUTH_ERROR'
  | 'TRANSCRIPTION_PROVIDER_AUTH_ERROR'
  | 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR'
  | 'TRANSCRIPTION_PROVIDER_ERROR'
  | 'TRANSCRIPTION_MALFORMED_RESPONSE'
  | 'TRANSCRIPTION_TIMEOUT'
  | 'TRANSCRIPTION_INTERNAL_ERROR';

/** Every code, so a test can compare the set against the migration's. */
export const TRANSCRIPTION_ERROR_CODES: readonly TranscriptionErrorCode[] = [
  'TRANSCRIPTION_EXHAUSTED_RETRIES',
  'TRANSCRIPTION_MEDIA_TOO_LARGE',
  'TRANSCRIPTION_MEDIA_UNAVAILABLE',
  'TRANSCRIPTION_MEDIA_AUTH_ERROR',
  'TRANSCRIPTION_PROVIDER_AUTH_ERROR',
  'TRANSCRIPTION_PROVIDER_CONFIG_ERROR',
  'TRANSCRIPTION_PROVIDER_ERROR',
  'TRANSCRIPTION_MALFORMED_RESPONSE',
  'TRANSCRIPTION_TIMEOUT',
  'TRANSCRIPTION_INTERNAL_ERROR',
];

export type TranscriptionSkipReason = 'FEATURE_DISABLED' | 'DRAFT_DISABLED';

/**
 * Provider failures worth another attempt.
 *
 * Identical to the draft worker's list. Kept as its own function rather than
 * imported from `draft-rpc-error-codes.ts` — not to avoid a dependency, but
 * because the two answer different questions that happen to agree today:
 * "should we call Langdock again" and "should we spend another Gladia
 * submission". If one ever needs to change, sharing the function would make
 * changing it change both.
 */
export function isTransientProviderCategory(category: ProviderErrorCategory): boolean {
  return (
    category === 'NETWORK_FAILURE' ||
    category === 'TIMEOUT' ||
    category === 'HTTP_408' ||
    category === 'HTTP_429' ||
    category === 'HTTP_5XX'
  );
}

/**
 * Media failures worth another attempt.
 *
 * Only two, and both because nothing was billed and the next attempt has a
 * real chance of a different answer: a 429/5xx from Meta, and a transfer whose
 * digest did not match.
 */
export function isTransientMediaCode(code: MediaErrorCode): boolean {
  return code === 'MEDIA_TRANSIENT' || code === 'MEDIA_INTEGRITY';
}

/**
 * Map a terminal provider failure to the code the archive RPC will accept.
 *
 * Transient categories never reach here — the worker retries them and, on the
 * last attempt, archives with TRANSCRIPTION_EXHAUSTED_RETRIES (or
 * TRANSCRIPTION_TIMEOUT for the one described in the file header). They are
 * still mapped rather than left to a `default`, so that adding a category to
 * the taxonomy is a compile error here rather than a silent
 * TRANSCRIPTION_INTERNAL_ERROR in production.
 */
export function mapProviderErrorToTranscriptionCode(
  category: ProviderErrorCategory
): TranscriptionErrorCode {
  switch (category) {
    case 'HTTP_401':
    case 'HTTP_403':
      return 'TRANSCRIPTION_PROVIDER_AUTH_ERROR';

    case 'INVALID_CONFIGURATION':
      // The key is absent or unusable, which is a different operator action
      // from a key that is present and rejected.
      return 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR';

    case 'MALFORMED_PROVIDER_RESPONSE':
      return 'TRANSCRIPTION_MALFORMED_RESPONSE';

    case 'TIMEOUT':
      return 'TRANSCRIPTION_TIMEOUT';

    case 'HTTP_400':
    case 'HTTP_404':
    case 'HTTP_422':
    case 'INVALID_REQUEST':
    case 'EMPTY_OUTPUT':
    case 'OUTPUT_TOO_LONG':
    case 'UNKNOWN_FAILURE':
      return 'TRANSCRIPTION_PROVIDER_ERROR';

    // Transient categories, mapped for exhaustiveness. Reaching one of these
    // means the retry budget ran out on it.
    case 'NETWORK_FAILURE':
    case 'HTTP_408':
    case 'HTTP_429':
    case 'HTTP_5XX':
      return 'TRANSCRIPTION_EXHAUSTED_RETRIES';
  }
}

/** Map a terminal media failure to the code the archive RPC will accept. */
export function mapMediaErrorToTranscriptionCode(code: MediaErrorCode): TranscriptionErrorCode {
  switch (code) {
    case 'MEDIA_TOO_LARGE':
      return 'TRANSCRIPTION_MEDIA_TOO_LARGE';

    case 'MEDIA_AUTH_ERROR':
      return 'TRANSCRIPTION_MEDIA_AUTH_ERROR';

    case 'MEDIA_UNAVAILABLE':
    case 'MEDIA_MALFORMED':
      // A response that did not have the documented shape is, from the job's
      // point of view, the same outcome as a media id Meta will not serve: no
      // usable audio exists. Kept distinct in the media layer's own taxonomy
      // (where it says something about Meta) and merged here (where the
      // question is only what to record about the job).
      return 'TRANSCRIPTION_MEDIA_UNAVAILABLE';

    // Transient, mapped for exhaustiveness. Reaching one means the retry
    // budget ran out on it.
    case 'MEDIA_TRANSIENT':
    case 'MEDIA_INTEGRITY':
      return 'TRANSCRIPTION_EXHAUSTED_RETRIES';
  }
}
