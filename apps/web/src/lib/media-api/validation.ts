/**
 * Media validation — shared by the server routes and the client form.
 *
 * The numeric rules mirror packages/ai-providers' ComfyUI adapter exactly:
 * video frames 1..81 following the 4n+1 rule (WAN 2.2 VAE temporal
 * constraint), fps 1..30. The DB enforces the same bounds as a backstop
 * (P3M12). The client predicates let the form reject without a round trip;
 * `validateSubmitBody` is the server UX and runs before the quota check so
 * a malformed request never consumes a quota decision.
 */

import type { MediaJobSubmitRequest } from './types';

export const PROMPT_MAX_LENGTH = 1000;
export const FPS_MIN = 1;
export const FPS_MAX = 30;
export const DEFAULT_FPS = 16;
export const FRAMES_MIN = 1;
export const FRAMES_MAX = 81;
export const DEFAULT_FRAMES = 81;

/** Prompt must be 1..1000 characters after trimming. */
export function isValidPrompt(prompt: string): boolean {
  const length = prompt.trim().length;
  return length >= 1 && length <= PROMPT_MAX_LENGTH;
}

/**
 * WAN 2.2 video frames: 1..81 AND 4n+1 (i.e. 1, 5, 9, …, 81).
 * Non-integers are rejected — "20.5" is not a frame count.
 */
export function isValidFrames(frames: number): boolean {
  return (
    Number.isInteger(frames) &&
    frames >= FRAMES_MIN &&
    frames <= FRAMES_MAX &&
    (frames - 1) % 4 === 0
  );
}

/** Frames per second: integer 1..30 inclusive. */
export function isValidFps(fps: number): boolean {
  return Number.isInteger(fps) && fps >= FPS_MIN && fps <= FPS_MAX;
}

export interface ValidationSuccess {
  ok: true;
  value: MediaJobSubmitRequest;
}

export interface ValidationFailure {
  ok: false;
  code: string;
  message: string;
}

function fail(message: string): ValidationFailure {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Validate the POST /api/v1/media/jobs body. Returns the normalized
 * request on success; on failure a stable INVALID_REQUEST with a message
 * naming the offending field.
 */
export function validateSubmitBody(
  body: unknown
): ValidationSuccess | ValidationFailure {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }

  const { kind, prompt, negativePrompt, params, idempotencyKey } = body;

  if (kind !== 'image' && kind !== 'video') {
    return fail("kind must be 'image' or 'video'");
  }

  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > PROMPT_MAX_LENGTH) {
    return fail('prompt must be between 1 and 1000 characters');
  }
  if (prompt.trim().length === 0) {
    return fail('prompt must not be blank');
  }

  if (negativePrompt !== undefined && typeof negativePrompt !== 'string') {
    return fail('negativePrompt must be a string');
  }

  if (params !== undefined && !isPlainObject(params)) {
    return fail('params must be a plain object');
  }

  // The video lane lives in params; image jobs ignore any lane value (the
  // service resolves those to the image lane). Checked here for the UX so
  // a bad lane never reaches the quota gate; the service re-validates.
  if (kind === 'video' && params !== undefined) {
    const lane = params['lane'];
    if (lane !== undefined && lane !== 'lightning' && lane !== 'quality') {
      return fail("params.lane must be 'lightning' or 'quality'");
    }
  }

  // Frames and fps live inside params; the rules are the adapter's.
  const frames = params?.['frames'];
  if (frames !== undefined) {
    if (typeof frames !== 'number' || !isValidFrames(frames)) {
      return fail('params.frames must be between 1 and 81 and follow the 4n+1 rule');
    }
  }

  const fps = params?.['fps'];
  if (fps !== undefined) {
    if (typeof fps !== 'number' || !isValidFps(fps)) {
      return fail('params.fps must be between 1 and 30');
    }
  }

  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0)
  ) {
    return fail('idempotencyKey must be a non-empty string');
  }

  return {
    ok: true,
    value: {
      kind,
      prompt,
      ...(negativePrompt !== undefined ? { negativePrompt } : {}),
      ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    },
  };
}
