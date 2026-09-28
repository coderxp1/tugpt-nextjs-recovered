import { describe, expect, it, vi, beforeEach } from 'vitest';
import { POST as jobsPOST, GET as jobsGET } from './route';
import { GET as jobDetailGET } from './[jobId]/route';
import { POST as cancelPOST } from './[jobId]/cancel/route';
import { GET as resultGET } from './[jobId]/result/route';

// --- Mocks ---

const mockRpc = vi.fn();
const mockAdminRpc = vi.fn();
const mockCreateSignedUrl = vi.fn();

function createChainableMock(overrides?: {
  singleResult?: { data: unknown; error: unknown };
  rangeResult?: { data: unknown; error: unknown; count: number };
}) {
  const singleResult = overrides?.singleResult ?? { data: null, error: { code: 'PGRST116' } };
  const rangeResult = overrides?.rangeResult ?? { data: [], error: null, count: 0 };

  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(singleResult);
  chain.range = vi.fn().mockResolvedValue(rangeResult);
  return chain;
}

const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: vi.fn(() =>
    Promise.resolve({
      rpc: mockRpc,
      from: mockFrom,
    })
  ),
}));

vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn(() => ({
    rpc: mockAdminRpc,
    storage: { from: vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl })) },
  })),
}));

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();

vi.mock('@tugpt/auth', () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: mockGetCurrentUser,
      resolveTenantContext: mockResolveTenantContext,
    };
  }),
}));

// --- Helpers ---

const JOB_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ORG_ID = 'org-1';

const JOB_ROW = {
  id: JOB_ID,
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

function makeRequest(url: string, options?: RequestInit) {
  return new Request(`http://localhost${url}`, {
    headers: { 'x-tenant-id': ORG_ID, ...options?.headers },
    ...options,
  });
}

function makeJobRequest(url: string, options?: RequestInit) {
  return makeRequest(url, {
    ...options,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

function makeParams(jobId: string) {
  return Promise.resolve({ jobId });
}

function setupSuccessAuth() {
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });
  mockResolveTenantContext.mockResolvedValue({
    organizationId: ORG_ID,
    organizationName: 'Test Org',
    role: 'owner',
  });
  mockAdminRpc.mockResolvedValue({ data: true, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupSuccessAuth();
});

// --- Tests ---

describe('Media API Routes', () => {
  describe('POST /api/v1/media/jobs', () => {
    it('R1: returns 401 when unauthenticated', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null);
      const res = await jobsPOST(makeJobRequest('/api/v1/media/jobs'));
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('UNAUTHENTICATED');
    });

    it('R2: returns 403 when no active tenant', async () => {
      mockResolveTenantContext.mockResolvedValueOnce(null);
      const res = await jobsPOST(makeJobRequest('/api/v1/media/jobs'));
      expect(res.status).toBe(403);
    });

    it('R3: returns 503 when the feature flag is off', async () => {
      mockAdminRpc.mockResolvedValueOnce({ data: false, error: null });
      const res = await jobsPOST(makeJobRequest('/api/v1/media/jobs'));
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error.code).toBe('FEATURE_UNAVAILABLE');
    });

    it('R4: returns 400 for an invalid kind', async () => {
      const res = await jobsPOST(
        makeJobRequest('/api/v1/media/jobs', {
          body: JSON.stringify({ kind: 'audio', prompt: 'x' }),
        })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('R5: returns 400 for frames violating the 4n+1 rule', async () => {
      const res = await jobsPOST(
        makeJobRequest('/api/v1/media/jobs', {
          body: JSON.stringify({ kind: 'video', prompt: 'x', params: { frames: 80 } }),
        })
      );
      expect(res.status).toBe(400);
      expect(mockAdminRpc).not.toHaveBeenCalledWith('submit_media_job', expect.anything());
    });

    it('R6: returns 202 with the job on success', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: { data: JOB_ROW, error: null },
      }));
      mockAdminRpc
        .mockResolvedValueOnce({ data: true, error: null }) // feature gate
        .mockResolvedValueOnce({
          data: [{ job_id: JOB_ID, already_exists: false, pgmq_msg_id: 7 }],
          error: null,
        }); // submit_media_job (atomic: quota + reserve + enqueue)

      const res = await jobsPOST(
        makeJobRequest('/api/v1/media/jobs', {
          body: JSON.stringify({ kind: 'image', prompt: 'Un cartel' }),
        })
      );
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.job.id).toBe(JOB_ID);
      expect(data.job.prompt).toBe('Un cartel');
    });

    it('R7: maps P3M16 to 429 QUOTA_EXCEEDED naming the lane', async () => {
      mockAdminRpc
        .mockResolvedValueOnce({ data: true, error: null })
        .mockResolvedValueOnce({
          data: null,
          error: {
            code: 'P3M16',
            message: 'MEDIA_QUOTA_EXCEEDED',
            details: 'lane=quality',
          },
        });

      const res = await jobsPOST(
        makeJobRequest('/api/v1/media/jobs', {
          body: JSON.stringify({
            kind: 'video',
            prompt: 'Un anuncio',
            params: { lane: 'quality' },
          }),
        })
      );
      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.error.code).toBe('QUOTA_EXCEEDED');
      expect(data.error.message).toContain('quality');
    });

    it('R7b: submits through the single atomic RPC with kind, prompt, and params', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: { data: JOB_ROW, error: null },
      }));
      mockAdminRpc
        .mockResolvedValueOnce({ data: true, error: null }) // feature gate
        .mockResolvedValueOnce({
          data: [{ job_id: JOB_ID, already_exists: false, pgmq_msg_id: 7 }],
          error: null,
        }); // submit_media_job (atomic: quota + reserve + enqueue)

      const res = await jobsPOST(
        makeJobRequest('/api/v1/media/jobs', {
          body: JSON.stringify({
            kind: 'video',
            prompt: 'Un anuncio',
            params: { lane: 'quality' },
          }),
        })
      );
      expect(res.status).toBe(202);
      expect(mockAdminRpc).toHaveBeenNthCalledWith(2, 'submit_media_job', {
        p_user_id: 'user-1',
        p_organization_id: ORG_ID,
        p_kind: 'video',
        p_prompt: 'Un anuncio',
        p_params: { lane: 'quality' },
        p_idempotency_key: null,
      });
    });

    it('R7c: rejects an unknown video lane with 400', async () => {
      const res = await jobsPOST(
        makeJobRequest('/api/v1/media/jobs', {
          body: JSON.stringify({
            kind: 'video',
            prompt: 'Un anuncio',
            params: { lane: 'ultrafast' },
          }),
        })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_REQUEST');
      // A malformed lane never reaches the submit RPC.
      expect(mockAdminRpc).not.toHaveBeenCalledWith(
        'submit_media_job',
        expect.anything()
      );
    });

    it('R8: maps P3M09 to 409 MEDIA_CONCURRENCY_EXCEEDED', async () => {
      mockAdminRpc
        .mockResolvedValueOnce({ data: true, error: null })
        .mockResolvedValueOnce({
          data: null,
          error: { code: 'P3M09', message: 'MEDIA_CONCURRENCY_EXCEEDED' },
        });

      const res = await jobsPOST(
        makeJobRequest('/api/v1/media/jobs', {
          body: JSON.stringify({ kind: 'image', prompt: 'Un cartel' }),
        })
      );
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error.code).toBe('MEDIA_CONCURRENCY_EXCEEDED');
    });
  });

  describe('GET /api/v1/media/jobs', () => {
    it('R9: returns the job list with pagination', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        rangeResult: { data: [JOB_ROW], error: null, count: 1 },
      }));

      const res = await jobsGET(makeRequest('/api/v1/media/jobs'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.jobs).toHaveLength(1);
      expect(data.total).toBe(1);
      expect(data.page).toBe(1);
      expect(data.limit).toBe(20);
    });

    it('R10: rejects an unknown status filter', async () => {
      const res = await jobsGET(makeRequest('/api/v1/media/jobs?status=bogus'));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_QUERY');
    });

    it('R11: accepts the media statuses', async () => {
      mockFrom.mockReturnValue(createChainableMock());
      for (const status of ['queued', 'processing', 'completed', 'cancelled', 'dead_lettered']) {
        const res = await jobsGET(makeRequest(`/api/v1/media/jobs?status=${status}`));
        expect(res.status, `status=${status}`).toBe(200);
      }
    });
  });

  describe('GET /api/v1/media/jobs/[jobId]', () => {
    it('R12: returns 400 for a malformed job id', async () => {
      const res = await jobDetailGET(makeRequest('/x'), { params: makeParams('not-a-uuid') });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_UUID');
    });

    it('R13: returns the job', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: { data: JOB_ROW, error: null },
      }));

      const res = await jobDetailGET(makeRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.job.id).toBe(JOB_ID);
    });

    it('R14: returns 404 MEDIA_JOB_NOT_FOUND for another org’s job (no leak)', async () => {
      mockFrom.mockReturnValue(createChainableMock());

      const res = await jobDetailGET(makeRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('MEDIA_JOB_NOT_FOUND');
    });
  });

  describe('POST /api/v1/media/jobs/[jobId]/cancel', () => {
    it('R15: cancels and returns the job', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: { data: JOB_ROW, error: null },
      }));
      mockAdminRpc
        .mockResolvedValueOnce({ data: true, error: null })
        .mockResolvedValueOnce({ data: true, error: null });

      const res = await cancelPOST(
        makeJobRequest('/x', { body: JSON.stringify({ reason: 'ya no hace falta' }) }),
        { params: makeParams(JOB_ID) }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.job.id).toBe(JOB_ID);
    });

    it('R16: returns 404 for an unknown job', async () => {
      mockFrom.mockReturnValue(createChainableMock());

      const res = await cancelPOST(makeJobRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(404);
    });

    it('R17: maps P3M11 to 409 INVALID_MEDIA_JOB_STATE', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: { data: JOB_ROW, error: null },
      }));
      mockAdminRpc
        .mockResolvedValueOnce({ data: true, error: null })
        .mockResolvedValueOnce({
          data: null,
          error: { code: 'P3M11', message: 'INVALID_MEDIA_JOB_STATE' },
        });

      const res = await cancelPOST(makeJobRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_MEDIA_JOB_STATE');
    });
  });

  describe('GET /api/v1/media/jobs/[jobId]/result', () => {
    it('R18: returns a signed URL for a completed job', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: {
          data: { ...JOB_ROW, status: 'completed', result_path: `${ORG_ID}/${JOB_ID}.png` },
          error: null,
        },
      }));
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed.example/x' },
        error: null,
      });

      const res = await resultGET(makeRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.url).toBe('https://signed.example/x');
      expect(data.expiresIn).toBe(300);
    });

    it('R19: returns 409 when the job has not completed', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: { data: JOB_ROW, error: null },
      }));

      const res = await resultGET(makeRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_MEDIA_JOB_STATE');
    });

    it('R20: returns 404 when the completed job has no result yet', async () => {
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: {
          data: { ...JOB_ROW, status: 'completed', result_path: null },
          error: null,
        },
      }));

      const res = await resultGET(makeRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('MEDIA_RESULT_NOT_FOUND');
    });

    it('R21: returns 404 for an unknown job', async () => {
      mockFrom.mockReturnValue(createChainableMock());

      const res = await resultGET(makeRequest('/x'), { params: makeParams(JOB_ID) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('MEDIA_JOB_NOT_FOUND');
    });
  });
});
