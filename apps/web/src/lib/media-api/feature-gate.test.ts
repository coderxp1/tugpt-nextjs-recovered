import { describe, expect, it, vi, beforeEach } from 'vitest';
import { checkMediaFeatureGate } from './feature-gate';
import type { TypedSupabaseClient } from '@tugpt/database';

const mockRpc = vi.fn();

function createMockClient() {
  return {
    rpc: mockRpc,
  } as unknown as TypedSupabaseClient;
}

describe('Media Feature Gate', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('F1: flag disabled returns 503 (fail closed)', async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const result = await checkMediaFeatureGate(createMockClient(), 'org-1');

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.message).toBe('Feature unavailable');
  });

  it('F2: flag enabled returns allowed', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    const result = await checkMediaFeatureGate(createMockClient(), 'org-1');

    expect(result.allowed).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('F3: RPC error returns 503 (fail closed)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });

    const result = await checkMediaFeatureGate(createMockClient(), 'org-1');

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(503);
  });

  it('F4: calls is_feature_enabled with the media_generation flag', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    await checkMediaFeatureGate(createMockClient(), 'org-1');

    expect(mockRpc).toHaveBeenCalledWith('is_feature_enabled', {
      p_organization_id: 'org-1',
      p_flag_key: 'media_generation',
    });
  });
});
