import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MediaApiService, RESULT_URL_EXPIRES_IN } from './service';
import type { TypedSupabaseClient } from '@tugpt/database';

const mockAdminRpc = vi.fn();
const mockCreateSignedUrl = vi.fn();

function createAdminClient() {
  return {
    rpc: mockAdminRpc,
    storage: { from: vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl })) },
  } as unknown as TypedSupabaseClient;
}

// Chainable query mock for the user-session client.
function createUserClient(overrides?: {
  singleResult?: { data: unknown; error: unknown };
  rangeResult?: { data: unknown; error: unknown; count: number };
}) {
  const singleResult = overrides?.singleResult ?? {
    data: null,
    error: { code: 'PGRST116' },
  };
  const rangeResult = overrides?.rangeResult ?? { data: [], error: null, count: 0 };

  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(singleResult);
  chain.range = vi.fn().mockResolvedValue(rangeResult);
  const from = vi.fn().mockReturnValue(chain);
  return { client: { from } as unknown as TypedSupabaseClient, from, chain };
}

const JOB_ROW = {
  id: 'job-1',
  kind: 'image',
  status: 'queued',
  prompt: 'Un cartel',
  params: {},
  prompt_id: null,
  attempts: 0,
  idempotency_key: null,
  error_code: null,
  error_reason: null,
  cancel_reason: null,
  result_path: null,
  gpu_seconds: null,
  created_at: '2026-09-28T00:00:00Z',
  updated_at: '2026-09-28T00:00:00Z',
  started_at: null,
  finished_at: null,
};

describe('MediaApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('submitMediaJob', () => {
    it('S1: submits through the single atomic submit_media_job RPC', async () => {
      const { client } = createUserClient({
        singleResult: { data: JOB_ROW, error: null },
      });
      mockAdminRpc.mockResolvedValueOnce({
        data: [{ job_id: 'job-1', already_exists: false, pgmq_msg_id: 7 }],
        error: null,
      });

      const service = new MediaApiService(client, createAdminClient());
      const job = await service.submitMediaJob('org-1', 'user-1', {
        kind: 'image',
        prompt: 'Un cartel',
      });

      // One RPC call: the lane/quota check, the reservation, and the
      // enqueue are atomic inside the database, so the service must not
      // split them into separate calls.
      expect(mockAdminRpc).toHaveBeenCalledTimes(1);
      expect(mockAdminRpc).toHaveBeenCalledWith('submit_media_job', {
        p_user_id: 'user-1',
        p_organization_id: 'org-1',
        p_kind: 'image',
        p_prompt: 'Un cartel',
        p_params: {},
        p_idempotency_key: null,
      });
      expect(job.id).toBe('job-1');
      expect(job.kind).toBe('image');
    });

    it('S1b: passes video params (including the lane) through to the RPC', async () => {
      const { client } = createUserClient({
        singleResult: { data: JOB_ROW, error: null },
      });
      mockAdminRpc.mockResolvedValueOnce({
        data: [{ job_id: 'job-1', already_exists: false, pgmq_msg_id: 7 }],
        error: null,
      });

      const service = new MediaApiService(client, createAdminClient());
      await service.submitMediaJob('org-1', 'user-1', {
        kind: 'video',
        prompt: 'Un anuncio',
        params: { lane: 'quality' },
        idempotencyKey: 'key-1',
      });

      expect(mockAdminRpc).toHaveBeenCalledTimes(1);
      expect(mockAdminRpc).toHaveBeenCalledWith('submit_media_job', {
        p_user_id: 'user-1',
        p_organization_id: 'org-1',
        p_kind: 'video',
        p_prompt: 'Un anuncio',
        p_params: { lane: 'quality' },
        p_idempotency_key: 'key-1',
      });
    });

    it('S2: folds top-level negativePrompt into params', async () => {
      const { client } = createUserClient({
        singleResult: { data: JOB_ROW, error: null },
      });
      mockAdminRpc.mockResolvedValueOnce({
        data: [{ job_id: 'job-1', already_exists: false, pgmq_msg_id: 7 }],
        error: null,
      });

      const service = new MediaApiService(client, createAdminClient());
      await service.submitMediaJob('org-1', 'user-1', {
        kind: 'image',
        prompt: 'Un cartel',
        negativePrompt: 'borroso',
        params: { width: 1024 },
      });

      expect(mockAdminRpc).toHaveBeenCalledTimes(1);
      expect(mockAdminRpc).toHaveBeenCalledWith('submit_media_job', {
        p_user_id: 'user-1',
        p_organization_id: 'org-1',
        p_kind: 'image',
        p_prompt: 'Un cartel',
        p_params: { width: 1024, negativePrompt: 'borroso' },
        p_idempotency_key: null,
      });
    });

    it('S3: rejects an invalid lane before any RPC call', async () => {
      const { client } = createUserClient();

      const service = new MediaApiService(client, createAdminClient());
      await expect(
        service.submitMediaJob('org-1', 'user-1', {
          kind: 'video',
          prompt: 'Un anuncio',
          params: { lane: 'ultrafast' },
        })
      ).rejects.toMatchObject({ code: 'P3M12' });
      // A malformed lane never reaches the database.
      expect(mockAdminRpc).not.toHaveBeenCalled();
    });

    it('S4: propagates the quota error from the single RPC', async () => {
      const { client } = createUserClient();
      const quotaError = { code: 'P3M16', message: 'MEDIA_QUOTA_EXCEEDED' };
      mockAdminRpc.mockResolvedValueOnce({ data: null, error: quotaError });

      const service = new MediaApiService(client, createAdminClient());
      await expect(
        service.submitMediaJob('org-1', 'user-1', { kind: 'image', prompt: 'x' })
      ).rejects.toEqual(quotaError);
      expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    });

    it('S4b: propagates the concurrency error from the single RPC', async () => {
      const { client } = createUserClient();
      const concurrencyError = { code: 'P3M09', message: 'MEDIA_CONCURRENCY_EXCEEDED' };
      mockAdminRpc.mockResolvedValueOnce({ data: null, error: concurrencyError });

      const service = new MediaApiService(client, createAdminClient());
      await expect(
        service.submitMediaJob('org-1', 'user-1', { kind: 'image', prompt: 'x' })
      ).rejects.toEqual(concurrencyError);
      expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    });
  });

  describe('listMediaJobs', () => {
    it('S5: filters by organization and clamps the limit', async () => {
      const { client, from, chain } = createUserClient({
        rangeResult: { data: [JOB_ROW], error: null, count: 1 },
      });

      const service = new MediaApiService(client, createAdminClient());
      const { jobs, total } = await service.listMediaJobs('org-1', 'queued', 1, 500);

      expect(from).toHaveBeenCalledWith('media_generation_jobs');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(chain.eq).toHaveBeenCalledWith('status', 'queued');
      // 500 requested, 50 is the clamp.
      expect(chain.range).toHaveBeenCalledWith(0, 49);
      expect(jobs).toHaveLength(1);
      expect(total).toBe(1);
      expect(jobs[0].createdAt).toBe('2026-09-28T00:00:00Z');
      expect(jobs[0].resultPath).toBeNull();
    });

    it('S6: omits the status filter for "all"', async () => {
      const { client, chain } = createUserClient();

      const service = new MediaApiService(client, createAdminClient());
      await service.listMediaJobs('org-1', 'all', 1, 20);

      const statusCalls = (chain.eq as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'status'
      );
      expect(statusCalls).toHaveLength(0);
    });
  });

  describe('getMediaJob', () => {
    it('S7: returns null when the job is missing (route answers 404)', async () => {
      const { client } = createUserClient();

      const service = new MediaApiService(client, createAdminClient());
      expect(await service.getMediaJob('org-1', 'missing')).toBeNull();
    });

    it('S8: scopes the lookup to the organization', async () => {
      const { client, chain } = createUserClient({
        singleResult: { data: JOB_ROW, error: null },
      });

      const service = new MediaApiService(client, createAdminClient());
      await service.getMediaJob('org-1', 'job-1');

      expect(chain.eq).toHaveBeenCalledWith('id', 'job-1');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });
  });

  describe('cancelMediaJob', () => {
    it('S9: returns null without calling the RPC when the job is not in this org', async () => {
      const { client } = createUserClient();

      const service = new MediaApiService(client, createAdminClient());
      const result = await service.cancelMediaJob('org-1', 'user-1', 'other-org-job');

      expect(result).toBeNull();
      expect(mockAdminRpc).not.toHaveBeenCalled();
    });

    it('S10: calls cancel_media_job with the reason, then refetches', async () => {
      const { client } = createUserClient({
        singleResult: { data: JOB_ROW, error: null },
      });
      mockAdminRpc.mockResolvedValueOnce({ data: true, error: null });

      const service = new MediaApiService(client, createAdminClient());
      const job = await service.cancelMediaJob('org-1', 'user-1', 'job-1', 'ya no hace falta');

      expect(mockAdminRpc).toHaveBeenCalledWith('cancel_media_job', {
        p_user_id: 'user-1',
        p_job_id: 'job-1',
        p_reason: 'ya no hace falta',
      });
      expect(job?.id).toBe('job-1');
    });

    it('S11: defaults the reason when none is given', async () => {
      const { client } = createUserClient({
        singleResult: { data: JOB_ROW, error: null },
      });
      mockAdminRpc.mockResolvedValueOnce({ data: true, error: null });

      const service = new MediaApiService(client, createAdminClient());
      await service.cancelMediaJob('org-1', 'user-1', 'job-1');

      expect(mockAdminRpc).toHaveBeenCalledWith(
        'cancel_media_job',
        expect.objectContaining({ p_reason: 'Cancelled by user' })
      );
    });
  });

  describe('createResultSignedUrl', () => {
    it('S12: mints a 300-second signed URL in the media bucket', async () => {
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed.example/x' },
        error: null,
      });

      const admin = createAdminClient();
      const service = new MediaApiService(
        createUserClient().client,
        admin
      );
      const url = await service.createResultSignedUrl('org-1/job-1.png');

      expect(admin.storage.from).toHaveBeenCalledWith('media');
      expect(mockCreateSignedUrl).toHaveBeenCalledWith('org-1/job-1.png', 300);
      expect(url).toBe('https://signed.example/x');
      expect(RESULT_URL_EXPIRES_IN).toBe(300);
    });

    it('S13: throws when signing fails', async () => {
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: null,
        error: { message: 'boom' },
      });

      const service = new MediaApiService(
        createUserClient().client,
        createAdminClient()
      );
      await expect(service.createResultSignedUrl('org-1/job-1.png')).rejects.toEqual({
        message: 'boom',
      });
    });
  });
});
