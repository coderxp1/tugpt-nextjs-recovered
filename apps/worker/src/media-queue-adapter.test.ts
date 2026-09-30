import { describe, it, expect, vi } from 'vitest';
import {
  MediaQueueAdapter,
  MediaQueueReadError,
  MediaQueueDeleteError,
  MediaQueueVisibilityError,
  MEDIA_DEFAULT_VISIBILITY_SECONDS,
} from './media-queue-adapter';

// Mock Supabase client
function createMockClient(rpcResult: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('media-queue-adapter', () => {
  it('readJobs calls the read_media_jobs RPC with media visibility defaults', async () => {
    const client = createMockClient({ data: [], error: null });
    const adapter = new MediaQueueAdapter(client);
    await adapter.readJobs(1);
    expect(client.rpc).toHaveBeenCalledWith('read_media_jobs', {
      p_visibility_timeout_seconds: MEDIA_DEFAULT_VISIBILITY_SECONDS,
      p_limit: 1,
    });
  });

  it('readJobs returns empty array when no messages', async () => {
    const adapter = new MediaQueueAdapter(createMockClient({ data: [], error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs).toEqual([]);
  });

  it('readJobs returns parsed messages with mediaJobId payload', async () => {
    const mockData = [
      {
        msg_id: '123',
        read_ct: 1,
        payload: { mediaJobId: 'job-uuid-1', requestId: 'media-job-uuid-1', timestamp: '2026-01-01T00:00:00Z' },
        enqueued_at: '2026-01-01T00:00:00Z',
        vt: '2026-01-01T00:10:00Z',
      },
    ];
    const adapter = new MediaQueueAdapter(createMockClient({ data: mockData, error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].msgId).toBe(123n);
    expect(jobs[0].readCt).toBe(1);
    expect(jobs[0].payload.mediaJobId).toBe('job-uuid-1');
  });

  it('readJobs throws MediaQueueReadError on RPC error', async () => {
    const adapter = new MediaQueueAdapter(
      createMockClient({ data: null, error: { code: 'P3M99', message: 'RPC failed' } })
    );
    await expect(adapter.readJobs(1)).rejects.toThrow(MediaQueueReadError);
  });

  it('deleteJob calls the delete_media_job RPC', async () => {
    const client = createMockClient({ data: true, error: null });
    const adapter = new MediaQueueAdapter(client);
    const ok = await adapter.deleteJob(123n);
    expect(client.rpc).toHaveBeenCalledWith('delete_media_job', { p_msg_id: '123' });
    expect(ok).toBe(true);
  });

  it('deleteJob throws MediaQueueDeleteError on RPC error', async () => {
    const adapter = new MediaQueueAdapter(
      createMockClient({ data: null, error: { code: 'XX', message: 'fail' } })
    );
    await expect(adapter.deleteJob(1n)).rejects.toThrow(MediaQueueDeleteError);
  });

  it('setVisibility calls the set_media_visibility RPC', async () => {
    const client = createMockClient({ data: true, error: null });
    const adapter = new MediaQueueAdapter(client);
    const ok = await adapter.setVisibility(123n, 600);
    expect(client.rpc).toHaveBeenCalledWith('set_media_visibility', {
      p_msg_id: '123',
      p_visibility_timeout_seconds: 600,
    });
    expect(ok).toBe(true);
  });

  it('setVisibility throws MediaQueueVisibilityError on RPC error', async () => {
    const adapter = new MediaQueueAdapter(
      createMockClient({ data: null, error: { code: 'XX', message: 'fail' } })
    );
    await expect(adapter.setVisibility(1n, 60)).rejects.toThrow(MediaQueueVisibilityError);
  });
});
