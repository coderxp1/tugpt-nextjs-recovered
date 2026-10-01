/**
 * Media validation tests — server-side body validation plus the pure
 * client-side predicates the form uses. No DOM needed: these are the same
 * rules the worker enforces (frames 1..81 AND 4n+1, fps 1..30), so the
 * boundary values here are the contract, not an implementation detail.
 */
import { describe, expect, it } from 'vitest';
import {
  isValidFrames,
  isValidFps,
  isValidPrompt,
  PROMPT_MAX_LENGTH,
  validateSubmitBody,
} from './validation';

describe('isValidPrompt', () => {
  it('accepts 1..1000 characters', () => {
    expect(isValidPrompt('a')).toBe(true);
    expect(isValidPrompt('x'.repeat(PROMPT_MAX_LENGTH))).toBe(true);
  });

  it('rejects empty and whitespace-only prompts', () => {
    expect(isValidPrompt('')).toBe(false);
    expect(isValidPrompt('   ')).toBe(false);
  });

  it('rejects prompts over 1000 characters', () => {
    expect(isValidPrompt('x'.repeat(PROMPT_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('isValidFrames', () => {
  it('accepts the 4n+1 ladder from 1 to 81', () => {
    for (let n = 1; n <= 81; n += 4) {
      expect(isValidFrames(n), `frames=${n}`).toBe(true);
    }
  });

  it('rejects values in range that are not 4n+1', () => {
    for (const n of [2, 3, 4, 6, 20, 80]) {
      expect(isValidFrames(n), `frames=${n}`).toBe(false);
    }
  });

  it('rejects out-of-range values', () => {
    for (const n of [0, -5, 82, 85, 100]) {
      expect(isValidFrames(n), `frames=${n}`).toBe(false);
    }
  });

  it('rejects non-integers', () => {
    expect(isValidFrames(20.5)).toBe(false);
    expect(isValidFrames(NaN)).toBe(false);
  });
});

describe('isValidFps', () => {
  it('accepts 1..30 inclusive', () => {
    expect(isValidFps(1)).toBe(true);
    expect(isValidFps(16)).toBe(true);
    expect(isValidFps(30)).toBe(true);
  });

  it('rejects out-of-range values', () => {
    expect(isValidFps(0)).toBe(false);
    expect(isValidFps(31)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isValidFps(15.5)).toBe(false);
  });
});

describe('validateSubmitBody', () => {
  const valid = {
    kind: 'image',
    prompt: 'Un cartel para la clínica',
  };

  it('V1: accepts a minimal valid image request', () => {
    const result = validateSubmitBody(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('image');
      expect(result.value.prompt).toBe(valid.prompt);
    }
  });

  it('V2: accepts a full video request with params', () => {
    const result = validateSubmitBody({
      kind: 'video',
      prompt: 'Un video de la clínica',
      negativePrompt: 'borroso',
      params: { frames: 81, fps: 16 },
      idempotencyKey: 'key-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.params).toEqual({ frames: 81, fps: 16 });
      expect(result.value.idempotencyKey).toBe('key-1');
    }
  });

  it('V3: rejects an unknown kind', () => {
    const result = validateSubmitBody({ ...valid, kind: 'audio' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_REQUEST');
  });

  it('V4: rejects an empty prompt and an over-long prompt', () => {
    expect(validateSubmitBody({ ...valid, prompt: '' }).ok).toBe(false);
    expect(validateSubmitBody({ ...valid, prompt: '   ' }).ok).toBe(false);
    expect(validateSubmitBody({ ...valid, prompt: 'x'.repeat(1001) }).ok).toBe(false);
  });

  it('V5: accepts a 1000-character prompt (the DB boundary)', () => {
    expect(validateSubmitBody({ ...valid, prompt: 'x'.repeat(1000) }).ok).toBe(true);
  });

  it('V6: rejects a non-object body', () => {
    expect(validateSubmitBody(null).ok).toBe(false);
    expect(validateSubmitBody('prompt').ok).toBe(false);
    expect(validateSubmitBody([{ ...valid }]).ok).toBe(false);
  });

  it('V7: rejects non-plain-object params', () => {
    expect(validateSubmitBody({ ...valid, params: 'frames' }).ok).toBe(false);
    expect(validateSubmitBody({ ...valid, params: [1, 2] }).ok).toBe(false);
    expect(validateSubmitBody({ ...valid, params: null }).ok).toBe(false);
  });

  it('V8: enforces the 4n+1 frame rule at the boundaries', () => {
    // Accepted: 1, 5, 81.
    for (const frames of [1, 5, 81]) {
      expect(
        validateSubmitBody({ ...valid, kind: 'video', params: { frames } }).ok,
        `frames=${frames} should be accepted`
      ).toBe(true);
    }
    // Rejected: 0, 2, 4, 80, 82, non-integer.
    for (const frames of [0, 2, 4, 80, 82, 16.5]) {
      const result = validateSubmitBody({ ...valid, kind: 'video', params: { frames } });
      expect(result.ok, `frames=${frames} should be rejected`).toBe(false);
    }
  });

  it('V9: enforces the 1-30 fps range at the boundaries', () => {
    for (const fps of [1, 16, 30]) {
      expect(
        validateSubmitBody({ ...valid, kind: 'video', params: { fps } }).ok,
        `fps=${fps} should be accepted`
      ).toBe(true);
    }
    for (const fps of [0, 31, 2.5]) {
      const result = validateSubmitBody({ ...valid, kind: 'video', params: { fps } });
      expect(result.ok, `fps=${fps} should be rejected`).toBe(false);
    }
  });

  it('V10: rejects a non-string negativePrompt', () => {
    const result = validateSubmitBody({ ...valid, negativePrompt: 42 });
    expect(result.ok).toBe(false);
  });

  it('V11: rejects a blank idempotency key', () => {
    const result = validateSubmitBody({ ...valid, idempotencyKey: '  ' });
    expect(result.ok).toBe(false);
  });

  it('V12: accepts both video lanes and no lane (defaults to lightning)', () => {
    for (const params of [{ lane: 'lightning' }, { lane: 'quality' }, undefined]) {
      const result = validateSubmitBody({
        kind: 'video',
        prompt: 'Un video',
        ...(params !== undefined ? { params } : {}),
      });
      expect(result.ok, `params=${JSON.stringify(params)} should be accepted`).toBe(true);
    }
  });

  it('V13: rejects an unknown video lane', () => {
    const result = validateSubmitBody({
      kind: 'video',
      prompt: 'Un video',
      params: { lane: 'ultrafast' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.message).toContain('params.lane');
    }
  });

  it('V14: ignores the lane for image jobs', () => {
    // The service resolves image jobs to the image lane; a stray lane
    // value must not fail validation.
    const result = validateSubmitBody({
      kind: 'image',
      prompt: 'Un cartel',
      params: { lane: 'quality' },
    });
    expect(result.ok).toBe(true);
  });
});
