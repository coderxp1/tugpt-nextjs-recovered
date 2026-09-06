/**
 * @file transcription-fixtures.ts
 * @description Deterministic test data for the transcription worker.
 *
 * All synthetic. No real credentials, phone numbers, media ids or customer
 * content.
 *
 * The mock client differs from `draft-fixtures.ts` in one way that matters:
 * `is_feature_enabled` dispatches on the flag key. The transcription worker
 * reads two flags and skips for different reasons depending on which is off,
 * so a mock that answered the same for both would make those two cases
 * indistinguishable — and one of them is a test that the worker does not spend
 * money.
 */

import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TranscriptionResult } from '@tugpt/ai-providers';

export const MOCK_JOB_ID = '11111111-e29b-41d4-a716-446655440000';
export const MOCK_ORG_ID = '22222222-e29b-41d4-a716-446655440000';
export const MOCK_CONVERSATION_ID = '33333333-e29b-41d4-a716-446655440000';
export const MOCK_SOURCE_MESSAGE_ID = '44444444-e29b-41d4-a716-446655440000';
export const MOCK_MSG_ID = 98765n;
export const MOCK_MEDIA_REFERENCE = 'media-id-abc123';
export const MOCK_PROVIDER_JOB_ID = 'gladia-job-7f2a';

export const MOCK_JOB_ROW = {
  id: MOCK_JOB_ID,
  organization_id: MOCK_ORG_ID,
  conversation_id: MOCK_CONVERSATION_ID,
  source_message_id: MOCK_SOURCE_MESSAGE_ID,
  media_reference: MOCK_MEDIA_REFERENCE,
  media_mime_type: 'audio/ogg; codecs=opus',
  provider_job_reference: null as string | null,
};

export const MOCK_TRANSCRIPT = 'Hola, quiero reservar una mesa para el martes.';

export const MOCK_AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x11, 0x22, 0x33, 0x44]);

/**
 * Deliberately stereo, and deliberately fractional.
 *
 * `billingSeconds` is Gladia's own billed quantity (duration x channels), so
 * 24.3 against an 12.15-second file is what a two-channel recording looks
 * like. Equal numbers would let a worker that recorded `audioSeconds` pass;
 * a whole number would let one that used `Math.floor` pass.
 */
export const MOCK_USAGE = {
  billingSeconds: 24.3,
  audioSeconds: 12.15,
  channels: 2,
};

export function mockResult(overrides: Partial<TranscriptionResult> = {}): TranscriptionResult {
  return {
    id: MOCK_PROVIDER_JOB_ID,
    provider: 'gladia',
    model: null,
    text: MOCK_TRANSCRIPT,
    languageCode: 'es',
    usage: MOCK_USAGE,
    latencyMs: 4200,
    ...overrides,
  };
}

export const MOCK_QUEUE_MESSAGE = {
  msgId: MOCK_MSG_ID,
  readCt: 1,
  payload: {
    transcriptionJobId: MOCK_JOB_ID,
    requestId: 'transcribe-test-001',
    timestamp: '2026-09-05T10:00:00.000Z',
  },
  enqueuedAt: '2026-09-05T09:59:00.000Z',
  vt: '2026-09-05T10:02:00.000Z',
};

export interface MockRpcConfig {
  [rpcName: string]: { data?: unknown; error?: { code: string; message: string } | null };
}

export interface MockClientOptions {
  rpc?: MockRpcConfig;
  /** Flag key -> enabled. Absent keys default to true. */
  flags?: Record<string, boolean>;
  /**
   * Make the flag lookup itself fail.
   *
   * Its own option rather than a value in `flags`, because "the answer was no"
   * and "there was no answer" are different facts and the worker must treat
   * the second as the first. A mutation that made a failed lookup return true
   * survived every assertion until this existed.
   */
  flagLookupFails?: boolean;
  /** The transcription_jobs row `.single()` returns. `null` means not found. */
  jobRow?: Record<string, unknown> | null;
}

export function createMockClient(options: MockClientOptions = {}): SupabaseClient {
  const { rpc = {}, flags = {}, jobRow = MOCK_JOB_ROW, flagLookupFails = false } = options;

  const client = {
    rpc: vi.fn().mockImplementation((name: string, params: Record<string, unknown>) => {
      if (name === 'is_feature_enabled') {
        if (flagLookupFails) {
          return Promise.resolve({
            data: null,
            error: { code: '57P01', message: 'connection terminated' },
          });
        }
        const key = params.p_flag_key as string;
        return Promise.resolve({ data: flags[key] ?? true, error: null });
      }
      const config = rpc[name];
      return Promise.resolve({
        data: config?.data ?? null,
        error: config?.error ?? null,
      });
    }),
    from: vi.fn().mockImplementation(() => {
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(() =>
          Promise.resolve(
            jobRow
              ? { data: jobRow, error: null }
              : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
          )
        ),
      };
      return builder;
    }),
  };

  return client as unknown as SupabaseClient;
}

/** Every RPC call the worker made, in order, as [name, params] pairs. */
export function rpcCalls(client: SupabaseClient): Array<[string, Record<string, unknown>]> {
  return (client as unknown as { rpc: { mock: { calls: Array<[string, Record<string, unknown>]> } } })
    .rpc.mock.calls;
}

export function rpcCall(
  client: SupabaseClient,
  name: string
): Record<string, unknown> | undefined {
  return rpcCalls(client).find(([n]) => n === name)?.[1];
}

export function rpcNames(client: SupabaseClient): string[] {
  return rpcCalls(client).map(([n]) => n);
}
