import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderErrorCategory } from '@tugpt/ai-providers';
import {
  TRANSCRIPTION_ERROR_CODES,
  isTransientMediaCode,
  isTransientProviderCategory,
  mapMediaErrorToTranscriptionCode,
  mapProviderErrorToTranscriptionCode,
} from '../src/transcription-rpc-error-codes';
import type { MediaErrorCode } from '../src/whatsapp-media';

/**
 * ===========================================================================
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 * ===========================================================================
 *
 * On 2026-08-19 the draft worker produced eight terminal error codes and its
 * archive RPC accepted five. Every terminal archive was rejected with P3B15,
 * logged, and dropped; the queue message was neither archived nor deleted, so
 * it was redelivered until the delivery limit dead-lettered it under
 * DRAFT_EXHAUSTED_RETRIES. A Langdock 400 presented as three exhausted
 * retries, and the provider's own complaint was recorded nowhere.
 *
 * The drift was between two files nobody diffs against each other. So this
 * test reads the migration and compares the two lists mechanically, in three
 * places: the `failed_jobs` CHECK constraint, the archive RPC's own allowlist,
 * and the TypeScript union.
 *
 * Reading the SQL with regexes is crude, and deliberately: a parser would be a
 * second thing to get wrong, and the failure mode here is the guard silently
 * matching nothing. That is what the first test in each group guards against —
 * each extraction asserts it found a plausible number of codes before
 * comparing anything.
 */

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
  '20260905000001_transcription_worker_rpcs.sql'
);

const sql = readFileSync(MIGRATION, 'utf8');

/** Every TRANSCRIPTION_* literal inside the failed_jobs CHECK constraint. */
function checkConstraintCodes(): string[] {
  const start = sql.indexOf('ADD CONSTRAINT failed_jobs_error_code_check');
  expect(start, 'failed_jobs CHECK constraint not found in the migration').toBeGreaterThan(-1);
  const end = sql.indexOf('CREATE OR REPLACE FUNCTION', start);
  const body = sql.slice(start, end);
  return [...new Set(body.match(/'TRANSCRIPTION_[A-Z_]+'/g) ?? [])].map((s) => s.slice(1, -1));
}

/** Every TRANSCRIPTION_* literal inside the archive RPC's own allowlist. */
function archiveAllowlistCodes(): string[] {
  const start = sql.indexOf('IF p_error_code IS NULL OR p_error_code NOT IN (');
  expect(start, 'archive allowlist not found in the migration').toBeGreaterThan(-1);
  const end = sql.indexOf('END IF;', start);
  const body = sql.slice(start, end);
  return [...new Set(body.match(/'TRANSCRIPTION_[A-Z_]+'/g) ?? [])].map((s) => s.slice(1, -1));
}

describe('the worker and the database agree on the vocabulary', () => {
  it('found a plausible number of codes in the migration (control for the two below)', () => {
    // Without this, a regex that matched nothing would make both comparisons
    // below compare an empty set to an empty set and pass — which is exactly
    // the shape of guard this codebase treats as a defect in itself.
    expect(checkConstraintCodes().length).toBeGreaterThanOrEqual(8);
    expect(archiveAllowlistCodes().length).toBeGreaterThanOrEqual(8);
    expect(TRANSCRIPTION_ERROR_CODES.length).toBeGreaterThanOrEqual(8);
  });

  it('the failed_jobs CHECK accepts exactly the codes the worker can produce', () => {
    expect([...checkConstraintCodes()].sort()).toEqual([...TRANSCRIPTION_ERROR_CODES].sort());
  });

  /**
   * The narrower of the two, and the one that actually failed in 2026-08-19:
   * the RPC's allowlist was a strict subset of the CHECK constraint, so the
   * codes it rejected were codes the database would happily have stored.
   */
  it('the archive RPC allowlist accepts exactly the same codes', () => {
    expect([...archiveAllowlistCodes()].sort()).toEqual([...TRANSCRIPTION_ERROR_CODES].sort());
  });

  it('lists no code twice', () => {
    expect(new Set(TRANSCRIPTION_ERROR_CODES).size).toBe(TRANSCRIPTION_ERROR_CODES.length);
  });
});

describe('transient classification', () => {
  const ALL_PROVIDER_CATEGORIES: ProviderErrorCategory[] = [
    'NETWORK_FAILURE',
    'TIMEOUT',
    'HTTP_408',
    'HTTP_429',
    'HTTP_5XX',
    'HTTP_400',
    'HTTP_401',
    'HTTP_403',
    'HTTP_404',
    'HTTP_422',
    'INVALID_CONFIGURATION',
    'INVALID_REQUEST',
    'MALFORMED_PROVIDER_RESPONSE',
    'EMPTY_OUTPUT',
    'OUTPUT_TOO_LONG',
    'UNKNOWN_FAILURE',
  ];

  const ALL_MEDIA_CODES: MediaErrorCode[] = [
    'MEDIA_UNAVAILABLE',
    'MEDIA_TOO_LARGE',
    'MEDIA_AUTH_ERROR',
    'MEDIA_TRANSIENT',
    'MEDIA_MALFORMED',
    'MEDIA_INTEGRITY',
  ];

  it.each(['NETWORK_FAILURE', 'TIMEOUT', 'HTTP_408', 'HTTP_429', 'HTTP_5XX'] as const)(
    'treats a provider %s as worth another attempt',
    (category) => {
      expect(isTransientProviderCategory(category)).toBe(true);
    }
  );

  /**
   * A 401 will fail identically three times, and each retry of a submission is
   * another charge. The negative half of the split is the half that costs
   * money to get wrong.
   */
  it.each(['HTTP_401', 'HTTP_403', 'HTTP_400', 'INVALID_CONFIGURATION', 'MALFORMED_PROVIDER_RESPONSE'] as const)(
    'treats a provider %s as terminal',
    (category) => {
      expect(isTransientProviderCategory(category)).toBe(false);
    }
  );

  /**
   * Nothing is billed for a download, and a truncated transfer has a real
   * chance of succeeding next time — the one case where "the data was wrong"
   * means "ask again" rather than "give up".
   */
  it('treats a truncated download as worth another attempt', () => {
    expect(isTransientMediaCode('MEDIA_INTEGRITY')).toBe(true);
  });

  it.each(['MEDIA_TOO_LARGE', 'MEDIA_UNAVAILABLE', 'MEDIA_AUTH_ERROR', 'MEDIA_MALFORMED'] as const)(
    'treats %s as terminal, because retrying reaches the same answer',
    (code) => {
      expect(isTransientMediaCode(code)).toBe(false);
    }
  );

  it('maps every provider category to a code the database will accept', () => {
    for (const category of ALL_PROVIDER_CATEGORIES) {
      expect(TRANSCRIPTION_ERROR_CODES).toContain(mapProviderErrorToTranscriptionCode(category));
    }
  });

  it('maps every media code to a code the database will accept', () => {
    for (const code of ALL_MEDIA_CODES) {
      expect(TRANSCRIPTION_ERROR_CODES).toContain(mapMediaErrorToTranscriptionCode(code));
    }
  });
});

describe('the mappings themselves', () => {
  /**
   * Three credentials, three operator actions: fix the Meta Graph token,
   * rotate the Gladia key, or put a Gladia key in the vault at all. A single
   * code covering them would make the dead-letter report say "an
   * authentication problem" and leave the operator to work out which.
   */
  it('distinguishes the three credential failures from each other', () => {
    const codes = new Set([
      mapMediaErrorToTranscriptionCode('MEDIA_AUTH_ERROR'),
      mapProviderErrorToTranscriptionCode('HTTP_401'),
      mapProviderErrorToTranscriptionCode('INVALID_CONFIGURATION'),
    ]);
    expect(codes.size).toBe(3);
  });

  it.each([
    ['HTTP_401', 'TRANSCRIPTION_PROVIDER_AUTH_ERROR'],
    ['HTTP_403', 'TRANSCRIPTION_PROVIDER_AUTH_ERROR'],
    ['INVALID_CONFIGURATION', 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR'],
    ['MALFORMED_PROVIDER_RESPONSE', 'TRANSCRIPTION_MALFORMED_RESPONSE'],
    ['TIMEOUT', 'TRANSCRIPTION_TIMEOUT'],
    ['HTTP_400', 'TRANSCRIPTION_PROVIDER_ERROR'],
    ['UNKNOWN_FAILURE', 'TRANSCRIPTION_PROVIDER_ERROR'],
  ] as const)('maps a provider %s to %s', (category, expected) => {
    expect(mapProviderErrorToTranscriptionCode(category)).toBe(expected);
  });

  it.each([
    ['MEDIA_TOO_LARGE', 'TRANSCRIPTION_MEDIA_TOO_LARGE'],
    ['MEDIA_UNAVAILABLE', 'TRANSCRIPTION_MEDIA_UNAVAILABLE'],
    ['MEDIA_MALFORMED', 'TRANSCRIPTION_MEDIA_UNAVAILABLE'],
    ['MEDIA_AUTH_ERROR', 'TRANSCRIPTION_MEDIA_AUTH_ERROR'],
  ] as const)('maps %s to %s', (code, expected) => {
    expect(mapMediaErrorToTranscriptionCode(code)).toBe(expected);
  });
});
