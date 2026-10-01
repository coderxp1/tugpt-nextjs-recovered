// Media API: SQLSTATE-to-HTTP error mapping with sanitized messages.
// Maps the media RPC SQLSTATEs (P3Mxx, see 20260927000001 / 20260928000002)
// to HTTP status codes and stable application messages.
// Raw database errors are NEVER exposed to the client.

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

const ERROR_MAP: Record<string, MappedError> = {
  // enqueue_media_job: the media_generation flag is off for this org.
  P3M10: { status: 403, code: 'FEATURE_UNAVAILABLE', message: 'Media generation is not available' },
  // enqueue_media_job / cancel_media_job: kind, prompt, params, or reason
  // failed validation before any side effect.
  P3M12: { status: 400, code: 'INVALID_REQUEST', message: 'Invalid media request' },
  // enqueue_media_job / cancel_media_job: the caller does not belong to
  // the named organization.
  P3M13: { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  // enqueue_media_job: idempotency key reused with different
  // prompt/kind/params.
  P3M14: { status: 409, code: 'MEDIA_IDEMPOTENCY_CONFLICT', message: 'This submission was already made with different content' },
  // cancel_media_job and friends: no such job. The routes also use this
  // for cross-org lookups so existence does not leak across tenants.
  P3M01: { status: 404, code: 'MEDIA_JOB_NOT_FOUND', message: 'Media job not found' },
  // cancel_media_job: the job is not in a cancellable state.
  P3M11: { status: 409, code: 'INVALID_MEDIA_JOB_STATE', message: 'This media job cannot be changed in its current state' },
  // enqueue_media_job: the org already has an active job (the partial
  // unique index mapped from unique_violation).
  P3M09: { status: 409, code: 'MEDIA_CONCURRENCY_EXCEEDED', message: 'This organization already has a media job running' },
};

const UNKNOWN_ERROR: MappedError = {
  status: 500,
  code: 'INTERNAL_ERROR',
  message: 'An unexpected error occurred',
};

/**
 * Every `code` this module can put on the wire.
 *
 * Exported so `apps/web/src/i18n/dictionaries.test.ts` can assert the
 * dictionaries have a translation for each one — the same guard the draft
 * API has, so a new media SQLSTATE cannot ship an English sentence into a
 * Spanish dashboard unnoticed.
 */
export function knownMediaErrorCodes(): string[] {
  return Array.from(
    new Set([
      ...Object.values(ERROR_MAP).map((e) => e.code),
      // Handled dynamically below (the message names the lane), so it is
      // not a static ERROR_MAP entry.
      'QUOTA_EXCEEDED',
      UNKNOWN_ERROR.code,
    ])
  );
}

// check_media_quota raises P3M16 with DETAIL = 'lane=<lane>'. Name the lane
// in the 429 message — the lanes have very different costs, so "quota
// exceeded" alone does not tell the caller which budget ran out.
const LANE_IN_DETAIL = /lane=(image|lightning|quality)/;

function quotaExceededError(error: unknown): MappedError {
  const details = (error as { details?: unknown } | null | undefined)?.details;
  const lane =
    typeof details === 'string' ? LANE_IN_DETAIL.exec(details)?.[1] : undefined;
  return {
    status: 429,
    code: 'QUOTA_EXCEEDED',
    message: lane
      ? `Media generation quota exceeded for lane '${lane}'`
      : 'Media generation quota exceeded',
  };
}

/**
 * Map a Supabase RPC error to an HTTP status code and sanitized message.
 * Inspects the error's `code` field for SQLSTATE codes (P3M01-P3M16).
 * Unknown errors default to HTTP 500 with a generic message.
 */
export function mapMediaRpcError(error: unknown): MappedError {
  if (!error) return UNKNOWN_ERROR;

  const err = error as { code?: string };
  const sqlstate = err?.code;

  if (sqlstate === 'P3M16') {
    return quotaExceededError(error);
  }

  if (sqlstate && ERROR_MAP[sqlstate]) {
    return ERROR_MAP[sqlstate];
  }

  return UNKNOWN_ERROR;
}
