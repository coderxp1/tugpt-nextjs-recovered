/**
 * `is_feature_enabled` is the only thing that answers "is this feature on for
 * this organization?" — and this file is what keeps that true.
 *
 * WHY IT MATTERS
 *
 * The safety argument for the whole flag system rests on one property. The
 * global row (`organization_id IS NULL`) cannot authorize an organization,
 * because it is never read alone: `is_feature_enabled` consumes it solely as
 * the left operand of an AND whose right operand is wrapped in
 * `COALESCE(..., false)`, so an organization with no row of its own resolves to
 * `false` no matter what the global row says.
 *
 * That argument is only as strong as its premise. The moment a second reader
 * appears — a route that queries `feature_flags` directly, a new RPC that
 * checks the global row on its own — the premise is false and nothing announces
 * it. The quota trigger added in 20260826000001 exempts the global row *on the
 * strength of this premise*, so a second reader silently widens that exemption
 * too.
 *
 * So the argument is made to enforce itself. Two halves:
 *
 *   1. CALL SITES — nothing outside the allowlists below may touch
 *      `feature_flags`. New readers fail here, and the fix is to call the RPC.
 *   2. SEMANTICS — `is_feature_enabled` must still be the logical AND described
 *      above. Rewriting it to an override chain, or dropping the COALESCE that
 *      makes a missing org row `false`, fails here even though no call site
 *      changed. This is the half a call-site check alone would miss.
 *
 * ADDING TO AN ALLOWLIST
 *
 * The allowlists are Maps, not arrays, because every entry owes a reason. If
 * you cannot write one sentence saying why your reader is not making an
 * authorization decision, it is making an authorization decision, and it
 * belongs behind `is_feature_enabled` instead.
 *
 * pgTAP fixtures under `supabase/tests/` are deliberately out of scope: they
 * seed and manipulate flags as setup, they are not a production path, and
 * guarding them would fail every test that exercises the flag system.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  scanFeatureFlags,
  FEATURE_FLAG_TABLE,
  FEATURE_FLAG_SQL_READ,
  DEFAULT_ALLOWED_TS_FLAGS,
  DEFAULT_ALLOWED_SQL_FLAGS,
} from './helpers/architectural-guards';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TABLE = FEATURE_FLAG_TABLE;
const ALLOWED_TS = DEFAULT_ALLOWED_TS_FLAGS;
const ALLOWED_SQL = DEFAULT_ALLOWED_SQL_FLAGS;
const SQL_READ = FEATURE_FLAG_SQL_READ;

describe('is_feature_enabled is the only reader of feature_flags', () => {
  const result = scanFeatureFlags(REPO_ROOT);

  it('finds the files it is guarding without traversal errors', () => {
    expect(result.traversalErrors).toEqual([]);
    expect(result.scannedFiles.filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(50);
    expect(result.scannedFiles.filter((f) => f.endsWith('.sql')).length).toBeGreaterThan(30);
  });

  it('no TypeScript outside the allowlist touches feature_flags', () => {
    const { tsViolations } = result;

    expect(
      tsViolations,
      `These files query feature_flags directly:\n  ${tsViolations.join('\n  ')}\n\n` +
        `Call public.is_feature_enabled(org_id, key) instead. It ANDs the global row ` +
        `with the org row and is the only place that answers whether a capability is ` +
        `on. A second reader breaks that guarantee, and the quota trigger in ` +
        `20260826000001 exempts the global row on the strength of it.\n\n` +
        `If this reader genuinely does not make an authorization decision, add it to ` +
        `ALLOWED_TS with a sentence saying why.`
    ).toEqual([]);
  });

  it('no migration outside the allowlist reads feature_flags', () => {
    const { sqlViolations } = result;

    expect(
      sqlViolations,
      `These migrations read feature_flags:\n  ${sqlViolations.join('\n  ')}\n\n` +
        `A function that reads the table to decide whether something is enabled is a ` +
        `second source of truth. Call public.is_feature_enabled instead, or add the ` +
        `migration to ALLOWED_SQL with a sentence saying why its read is not an ` +
        `authorization decision.`
    ).toEqual([]);
  });

  /**
   * An allowlist that outlives its entries stops being a list of exceptions and
   * becomes a list of places nobody checked. Each entry must still be real.
   */
  it('every allowlist entry still refers to something', () => {
    const stale: string[] = [];

    for (const rel of ALLOWED_TS.keys()) {
      let content: string;
      try {
        content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      if (!content.includes(TABLE)) stale.push(`${rel} (no longer mentions ${TABLE})`);
    }

    for (const name of ALLOWED_SQL.keys()) {
      const full = path.join(REPO_ROOT, 'supabase', 'migrations', name);
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        stale.push(`${name} (migration no longer exists)`);
        continue;
      }
      if (!SQL_READ.test(content)) stale.push(`${name} (no longer reads ${TABLE})`);
    }

    expect(stale, `Remove these stale allowlist entries:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});

/**
 * The second half. A call-site check alone would pass while the RPC itself was
 * rewritten into something that does not gate at all.
 */
describe('is_feature_enabled still resolves as a logical AND', () => {
  const source = (): string =>
    readFileSync(
      path.join(REPO_ROOT, 'supabase', 'migrations', '20260805000013_create_is_feature_enabled_rpc.sql'),
      'utf8'
    );

  it('reads the global row and the org row separately', () => {
    const sql = source();
    expect(sql, 'the global-row read is gone').toMatch(/organization_id\s+IS\s+NULL\s+AND\s+key\s*=\s*p_flag_key/i);
    expect(sql, 'the org-row read is gone').toMatch(/organization_id\s*=\s*p_organization_id\s+AND\s+key\s*=\s*p_flag_key/i);
  });

  it('combines them with AND, not an override chain', () => {
    expect(
      source(),
      'is_feature_enabled no longer ANDs the two rows. An override chain would let a ' +
        'global true enable organizations that never opted in.'
    ).toMatch(/\bAND\b/i);
  });

  it('treats a missing org row as false, never as "inherit global"', () => {
    expect(
      source(),
      'the COALESCE(..., false) around the org-row read is gone. Without it a missing ' +
        'org row is NULL, and NULL AND true is NULL — which a caller reading the result ' +
        'as a boolean may not treat as false.'
    ).toMatch(/COALESCE\s*\(\s*\n?\s*\(\s*SELECT\s+is_enabled[\s\S]*?\bfalse\s*\)/i);
  });

  it('stays service_role only', () => {
    const sql = source();
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.is_feature_enabled/i);
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.is_feature_enabled[\s\S]*?TO\s+service_role/i);
  });
});
