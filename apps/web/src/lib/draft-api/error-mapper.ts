// Stage 5A: SQLSTATE-to-HTTP error mapping with sanitized messages
// Maps database RPC error codes to HTTP status codes and stable application messages.
// Raw database errors are NEVER exposed to the client.

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

const ERROR_MAP: Record<string, MappedError> = {
  P3B01: { status: 404, code: 'DRAFT_NOT_FOUND', message: 'Draft not found' },
  P3B02: { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  P3B03: { status: 409, code: 'STALE_VERSION', message: 'This draft has been modified by another reviewer. Please reload and try again.' },
  P3B04: { status: 422, code: 'INVALID_STATE_TRANSITION', message: 'This draft cannot be modified in its current state' },
  P3B05: { status: 422, code: 'INVALID_BODY', message: 'The draft body must not be empty' },

  // Conversation operations — assignment and handoff (migration 20260901000002).
  //
  // A separate range from P3B0x on purpose. Those are the draft-review codes and
  // the messages above talk about drafts; "this draft has been modified by
  // another reviewer" is the wrong sentence for a conversation someone else has
  // claimed, and reusing P3B03 for it would have put that sentence on screen.
  //
  // This file is still called `draft-api/error-mapper.ts` and still exports
  // `knownDraftErrorCodes`. It is now the mapper for every RPC SQLSTATE the API
  // surfaces, not just the draft ones, and the name is behind the fact.
  // Renaming it touches every route plus the dictionary guard, which is a
  // change worth making on its own rather than inside a migration PR.
  P3C01: { status: 404, code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' },
  P3C02: { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  P3C03: { status: 422, code: 'ASSIGNEE_NOT_A_MEMBER', message: 'That person is not a member of this organization' },
  P3C04: { status: 409, code: 'ASSIGNMENT_CONFLICT', message: 'Someone else changed this conversation first. Please reload and try again.' },
  P3C05: { status: 422, code: 'INVALID_STATUS_TRANSITION', message: 'This conversation cannot be changed in its current state' },

  // Invitations (20260902000001). P3D01 is deliberately 404 for three distinct
  // causes — no such invitation, not a member of that organization, and a
  // token that does not match — because distinguishing them lets an
  // authenticated stranger enumerate organization and invitation ids by
  // watching which error comes back.
  P3D01: { status: 404, code: 'INVITATION_NOT_FOUND', message: 'Invitation not found' },
  P3D02: { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  P3D03: { status: 409, code: 'INVITATION_ALREADY_PENDING', message: 'This address already has a pending invitation. Revoke it before sending another.' },
  P3D04: { status: 409, code: 'INVITATION_NOT_PENDING', message: 'This invitation has already been used or withdrawn' },
  // 410 rather than 404: the invitation was real, and the difference tells the
  // invitee to ask for a new one rather than to check the link for typos.
  P3D05: { status: 410, code: 'INVITATION_EXPIRED', message: 'This invitation has expired. Ask for a new one.' },
  P3D06: { status: 403, code: 'INVITATION_WRONG_ACCOUNT', message: 'This invitation was sent to a different email address. Sign in with that address to accept it.' },
  P3D07: { status: 409, code: 'ALREADY_A_MEMBER', message: 'That person is already in this organization' },
  P3D08: { status: 403, code: 'ROLE_ABOVE_YOUR_OWN', message: 'You cannot invite someone at a role above your own' },
  P3D09: { status: 422, code: 'INVALID_EMAIL', message: 'That is not a valid email address' },

  // Analytics v1 — the usage & cost summary read path (migration
  // 20260911000001). Its own range for the reason the P3C block gives: a
  // code is a contract with the screen, and the sentences above talk about
  // drafts, conversations and invitations.
  P3J01: { status: 401, code: 'UNAUTHENTICATED', message: 'Authentication required' },
  // 403 rather than 404: the RPC answers "non-member" and "nonexistent
  // organization" with this ONE code so it cannot be used to enumerate
  // organization ids, and both readings amount to the same sentence for the
  // caller — you may not see this organization's usage.
  P3J02: { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  // Unreachable through the route, which validates the window before calling
  // — mapped anyway, because "the database refused and the screen showed
  // INTERNAL_ERROR" is how a validation contract rots silently.
  P3J03: { status: 400, code: 'INVALID_QUERY', message: 'Invalid time window' },
  P3J04: { status: 400, code: 'QUERY_WINDOW_TOO_LARGE', message: 'The requested time window is too large' },
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
 * dictionaries have a translation for each one. Without that, adding a SQLSTATE
 * here ships an English sentence into a Spanish dashboard and nothing fails.
 */
export function knownDraftErrorCodes(): string[] {
  return Array.from(
    new Set([...Object.values(ERROR_MAP).map((e) => e.code), UNKNOWN_ERROR.code])
  );
}

/**
 * Map a Supabase RPC error to an HTTP status code and sanitized message.
 * Inspects the error's `code` field for SQLSTATE codes (P3B01-P3B05).
 * Unknown errors default to HTTP 500 with a generic message.
 */
export function mapDraftRpcError(error: unknown): MappedError {
  if (!error) return UNKNOWN_ERROR;

  const err = error as { code?: string };
  const sqlstate = err?.code;

  if (sqlstate && ERROR_MAP[sqlstate]) {
    return ERROR_MAP[sqlstate];
  }

  return UNKNOWN_ERROR;
}
