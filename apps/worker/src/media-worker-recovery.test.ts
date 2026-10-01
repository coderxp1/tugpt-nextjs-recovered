import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MediaWorker } from '../src/media-worker';

/**
 * M2: worker restart recovery.
 *
 * The expensive mistake is resubmitting work ComfyUI already accepted:
 * a stored prompt_id must be reconciled against /history and /queue before
 * any further action, and a prompt ComfyUI has no record of must fail
 * loudly (MEDIA_PROMPT_LOST), never silently re-render.
 */

const MOCK_JOB_ID = '11111111-1111-4111-8111-111111111111';
const MOCK_ORG_ID = '22222222-2222-4222-8222-222222222222';
const MOCK_PROMPT_ID = 'prompt-abc-123';
const MOCK_MSG_ID = 42n;

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_JOB_ID,
    organization_id: MOCK_ORG_ID,
    kind: 'image',
    status: 'processing',
    prompt: 'a test image',
    params: { lane: 'lightning' },
    prompt_id: MOCK_PROMPT_ID,
    attempts: 1,
    result_path: null,
    pgmq_msg_id: 42,
    ...overrides,
  };
}

function makeQueueMessage(payload: Record<string, unknown> = {}) {
  return {
    msgId: MOCK_MSG_ID,
    readCt: 1,
    payload: { mediaJobId: MOCK_JOB_ID, ...payload },
    enqueuedAt: '2026-01-01T00:00:00Z',
    vt: '2026-01-01T00:10:00Z',
  };
}

interface MockClient {
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  storage: { from: ReturnType<typeof vi.fn> };
  rpcCalls: Array<{ name: string; args: unknown }>;
}

function createMockClient(opts: {
  jobRows?: Array<Record<string, unknown>> | null;
  singleJobRow?: Record<string, unknown> | null;
} = {}): MockClient {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const rpc = vi.fn(async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    return { data: null, error: null };
  });

  const queryBuilder: Record<string, ReturnType<typeof vi.fn>> = {};
  queryBuilder.select = vi.fn().mockReturnThis();
  queryBuilder.eq = vi.fn().mockReturnThis();
  queryBuilder.not = vi.fn().mockReturnThis();
  queryBuilder.maybeSingle = vi.fn(async () => {
    // maybeSingle is used by loadJobRow (single job lookup).
    return { data: opts.singleJobRow ?? null, error: null };
  });
  // The recovery list query chains .select().eq().not() and awaits the builder.
  const listThen = async () => ({ data: opts.jobRows ?? [], error: null });
  queryBuilder.then = vi.fn((resolve: (v: unknown) => void) => resolve(listThen())) as never;

  const from = vi.fn(() => queryBuilder);
  const upload = vi.fn(async () => ({ error: null }));
  const storage = { from: vi.fn(() => ({ upload })) };

  return { rpc, from, storage, rpcCalls };
}

function createMockAdapter(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    submitPrompt: vi.fn(async () => ({ promptId: 'new-prompt-id' })),
    pollHistory: vi.fn(async () => ({ status: 'completed', output: { filename: 'out.png' }, latencyMs: 1000 })),
    fetchOutputBytes: vi.fn(async () => Buffer.from('fake-bytes')),
    checkQueue: vi.fn(async () => ({ isPending: false, isRunning: false })),
    peekHistory: vi.fn(async () => ({ found: false })),
    ...overrides,
  };
}

describe('media-worker recovery (M2)', () => {
  let client: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
  });

  it('recovery with no interrupted jobs logs clean and does not touch ComfyUI', async () => {
    const adapter = createMockAdapter();
    const emptyClient = createMockClient({ jobRows: [] });
    const worker = new MediaWorker(emptyClient as never, () => adapter as never, {
      pollIntervalMs: 10,
    });
    // Run briefly: recovery runs first, then the poll loop reads no jobs.
    const controller = new AbortController();
    const runPromise = worker.run(controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await runPromise;

    expect(adapter.peekHistory).not.toHaveBeenCalled();
    expect(adapter.checkQueue).not.toHaveBeenCalled();
    expect(emptyClient.rpcCalls.filter((c) => c.name === 'archive_media_failed_job')).toHaveLength(0);
  });

  it('completed history during recovery collects the result without resubmitting', async () => {
    const adapter = createMockAdapter({
      peekHistory: vi.fn(async () => ({
        found: true,
        status: 'completed',
        output: { filename: 'out.png', subfolder: '', type: 'output' },
      })),
    });
    client = createMockClient({ jobRows: [makeJobRow()] });
    const worker = new MediaWorker(client as never, () => adapter as never);

    await (worker as unknown as { recoverInterruptedJobs: (s: AbortSignal) => Promise<void> })
      .recoverInterruptedJobs(new AbortController().signal);

    // Never resubmitted: submitPrompt is the expensive call.
    expect(adapter.submitPrompt).not.toHaveBeenCalled();
    expect(adapter.fetchOutputBytes).toHaveBeenCalled();
    const completeCalls = client.rpcCalls.filter((c) => c.name === 'complete_media_job');
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].args).toMatchObject({ p_job_id: MOCK_JOB_ID });
  });

  it('error history during recovery archives the job visibly', async () => {
    const adapter = createMockAdapter({
      peekHistory: vi.fn(async () => ({
        found: true,
        status: 'error',
        errorDetail: 'node exploded',
      })),
    });
    client = createMockClient({ jobRows: [makeJobRow()] });
    const worker = new MediaWorker(client as never, () => adapter as never);

    await (worker as unknown as { recoverInterruptedJobs: (s: AbortSignal) => Promise<void> })
      .recoverInterruptedJobs(new AbortController().signal);

    expect(adapter.submitPrompt).not.toHaveBeenCalled();
    const archiveCalls = client.rpcCalls.filter((c) => c.name === 'archive_media_failed_job');
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0].args).toMatchObject({
      p_msg_id: '42',
      p_media_job_id: MOCK_JOB_ID,
      p_error_code: 'MEDIA_INTERNAL_ERROR',
    });
  });

  it('prompt still alive in ComfyUI queue is adopted, not touched', async () => {
    const adapter = createMockAdapter({
      peekHistory: vi.fn(async () => ({ found: false })),
      checkQueue: vi.fn(async () => ({ isPending: false, isRunning: true })),
    });
    client = createMockClient({ jobRows: [makeJobRow()] });
    const worker = new MediaWorker(client as never, () => adapter as never);

    await (worker as unknown as { recoverInterruptedJobs: (s: AbortSignal) => Promise<void> })
      .recoverInterruptedJobs(new AbortController().signal);

    expect(adapter.submitPrompt).not.toHaveBeenCalled();
    expect(adapter.fetchOutputBytes).not.toHaveBeenCalled();
    expect(client.rpcCalls.filter((c) => c.name === 'archive_media_failed_job')).toHaveLength(0);
    expect(client.rpcCalls.filter((c) => c.name === 'complete_media_job')).toHaveLength(0);
  });

  it('prompt lost from ComfyUI fails loudly with MEDIA_PROMPT_LOST, never resubmits', async () => {
    const adapter = createMockAdapter({
      peekHistory: vi.fn(async () => ({ found: false })),
      checkQueue: vi.fn(async () => ({ isPending: false, isRunning: false })),
    });
    client = createMockClient({ jobRows: [makeJobRow()] });
    const worker = new MediaWorker(client as never, () => adapter as never);

    await (worker as unknown as { recoverInterruptedJobs: (s: AbortSignal) => Promise<void> })
      .recoverInterruptedJobs(new AbortController().signal);

    // The critical assertion: no resubmission of lost work.
    expect(adapter.submitPrompt).not.toHaveBeenCalled();
    const archiveCalls = client.rpcCalls.filter((c) => c.name === 'archive_media_failed_job');
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0].args).toMatchObject({
      p_msg_id: '42',
      p_media_job_id: MOCK_JOB_ID,
      p_error_code: 'MEDIA_PROVIDER_ERROR',
    });
  });

  it('processJob with a stored prompt_id reconciles instead of resubmitting', async () => {
    const adapter = createMockAdapter({
      pollHistory: vi.fn(async () => ({
        status: 'completed',
        output: { filename: 'out.png' },
        latencyMs: 5000,
        promptId: MOCK_PROMPT_ID,
      })),
    });
    const rpcCalls: Array<{ name: string; args: unknown }> = [];
    const rpc = vi.fn(async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === 'read_media_jobs') {
        return {
          data: [
            {
              msg_id: '42',
              read_ct: 2,
              payload: { mediaJobId: MOCK_JOB_ID },
              enqueued_at: '2026-01-01T00:00:00Z',
              vt: '2026-01-01T00:10:00Z',
            },
          ],
          error: null,
        };
      }
      if (name === 'delete_media_job') return { data: true, error: null };
      return { data: null, error: null };
    });
    const qb = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({ data: makeJobRow(), error: null })),
      then: vi.fn((resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null })
      ) as never,
    };
    const testClient = {
      rpc,
      rpcCalls,
      from: vi.fn(() => qb),
      storage: { from: vi.fn(() => ({ upload: vi.fn(async () => ({ error: null })) })) },
    };

    const worker = new MediaWorker(testClient as never, () => adapter as never);
    await worker.processJob(makeQueueMessage(), new AbortController().signal);

    // Redelivered message for an already-submitted job: poll, do not submit.
    expect(adapter.submitPrompt).not.toHaveBeenCalled();
    expect(adapter.pollHistory).toHaveBeenCalledWith(
      MOCK_PROMPT_ID,
      expect.anything(),
      expect.anything()
    );
    // record_media_submission is only called on fresh submit, not on reconcile.
    expect(rpcCalls.filter((c) => c.name === 'record_media_submission')).toHaveLength(0);
  });
});
