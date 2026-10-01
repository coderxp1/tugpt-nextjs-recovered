import { describe, expect, it } from 'vitest';
import { mapMediaRpcError, knownMediaErrorCodes } from './error-mapper';

describe('mapMediaRpcError', () => {
  it('M1: P3M16 quota exceeded maps to 429 QUOTA_EXCEEDED', () => {
    const mapped = mapMediaRpcError({ code: 'P3M16', message: 'MEDIA_QUOTA_EXCEEDED' });
    expect(mapped).toEqual({
      status: 429,
      code: 'QUOTA_EXCEEDED',
      message: 'Media generation quota exceeded',
    });
  });

  it('M1b: P3M16 names the lane from the RPC detail', () => {
    for (const lane of ['lightning', 'quality', 'image']) {
      const mapped = mapMediaRpcError({
        code: 'P3M16',
        message: 'MEDIA_QUOTA_EXCEEDED',
        details: `lane=${lane}`,
      });
      expect(mapped.status).toBe(429);
      expect(mapped.code).toBe('QUOTA_EXCEEDED');
      expect(mapped.message).toBe(`Media generation quota exceeded for lane '${lane}'`);
    }
  });

  it('M1c: P3M16 without a parseable detail falls back to the generic message', () => {
    const mapped = mapMediaRpcError({
      code: 'P3M16',
      message: 'MEDIA_QUOTA_EXCEEDED',
      details: 'something unexpected',
    });
    expect(mapped.status).toBe(429);
    expect(mapped.code).toBe('QUOTA_EXCEEDED');
    expect(mapped.message).toBe('Media generation quota exceeded');
  });

  it('M2: P3M10 feature disabled maps to 403 FEATURE_UNAVAILABLE', () => {
    const mapped = mapMediaRpcError({ code: 'P3M10' });
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe('FEATURE_UNAVAILABLE');
  });

  it('M3: P3M12 invalid params maps to 400 INVALID_REQUEST', () => {
    const mapped = mapMediaRpcError({ code: 'P3M12' });
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('INVALID_REQUEST');
  });

  it('M4: P3M13 tenant mismatch maps to 403 FORBIDDEN', () => {
    const mapped = mapMediaRpcError({ code: 'P3M13' });
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe('FORBIDDEN');
  });

  it('M5: P3M14 idempotency conflict maps to 409 MEDIA_IDEMPOTENCY_CONFLICT', () => {
    const mapped = mapMediaRpcError({ code: 'P3M14' });
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('MEDIA_IDEMPOTENCY_CONFLICT');
  });

  it('M6: P3M09 concurrency exceeded maps to 409 MEDIA_CONCURRENCY_EXCEEDED', () => {
    const mapped = mapMediaRpcError({ code: 'P3M09' });
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('MEDIA_CONCURRENCY_EXCEEDED');
  });

  it('M7: P3M01 job not found maps to 404 MEDIA_JOB_NOT_FOUND', () => {
    const mapped = mapMediaRpcError({ code: 'P3M01' });
    expect(mapped.status).toBe(404);
    expect(mapped.code).toBe('MEDIA_JOB_NOT_FOUND');
  });

  it('M8: P3M11 invalid state maps to 409 INVALID_MEDIA_JOB_STATE', () => {
    const mapped = mapMediaRpcError({ code: 'P3M11' });
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('INVALID_MEDIA_JOB_STATE');
  });

  it('M9: unknown SQLSTATE maps to 500 INTERNAL_ERROR without leaking the message', () => {
    const mapped = mapMediaRpcError({ code: 'XX999', message: 'something internal' });
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.message).not.toContain('something internal');
  });

  it('M10: null error maps to 500 INTERNAL_ERROR', () => {
    const mapped = mapMediaRpcError(null);
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('INTERNAL_ERROR');
  });

  it('M11: every emitted code is in the known-codes list', () => {
    const codes = knownMediaErrorCodes();
    for (const code of [
      'QUOTA_EXCEEDED',
      'FEATURE_UNAVAILABLE',
      'INVALID_REQUEST',
      'FORBIDDEN',
      'MEDIA_IDEMPOTENCY_CONFLICT',
      'MEDIA_CONCURRENCY_EXCEEDED',
      'MEDIA_JOB_NOT_FOUND',
      'INVALID_MEDIA_JOB_STATE',
      'INTERNAL_ERROR',
    ]) {
      expect(codes).toContain(code);
    }
  });
});
