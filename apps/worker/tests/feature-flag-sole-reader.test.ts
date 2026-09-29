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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TABLE = 'feature_flags';

/**
 * TypeScript files permitted to mention `feature_flags`, and why each one is
 * not an authorization decision.
 */
const ALLOWED_TS = new Map<string, string>([
  [
    'packages/database/src/types.ts',
    'Generated Supabase type map. Declares the table shape; performs no query.',
  ],
  [
    'apps/worker/src/e2e/milestone1.ts',
    'E2E harness. Arms the global row and an org row as test setup, then restores ' +
      'them on teardown. It also calls is_feature_enabled to assert the resolved ' +
      'answer rather than inferring it from the rows it just wrote — which is the ' +
      'behaviour this guard exists to require.',
  ],
]);

/**
 * Migrations permitted to read `feature_flags`, and why.
 *
 * Writes are not listed: creating or flipping a row is what the table is for,
 * and a write cannot silently become a second source of truth for "is this on".
 * Reads can, which is why only reads are guarded here.
 */
const ALLOWED_SQL = new Map<string, string>([
  [
    '20260805000013_create_is_feature_enabled_rpc.sql',
    'Defines is_feature_enabled. This is the sanctioned reader.',
  ],
  [
    '20260826000001_draft_quota_period_lifecycle.sql',
    'enable_draft_generation_for_org reads the global row to REPORT it as the ' +
      'global_flag_enabled output. The authoritative answer in that same function ' +
      'comes from calling is_feature_enabled, not from this read.',
  ],
]);

const SQL_READ = /FROM\s+(?:public\.)?feature_flags/i;

/** Every .ts/.tsx file under the given roots, skipping build output and deps. */
function sourceFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') {
        continue;
      }
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  for (const root of roots) walk(path.join(REPO_ROOT, root));
  return out;
}

function migrationFiles(): string[] {
  const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('is_feature_enabled is the only reader of feature_flags', () => {
  it('finds the files it is guarding (a moved tree must fail loudly, not silently pass)', () => {
    expect(sourceFiles(['apps', 'packages']).length).toBeGreaterThan(50);
    expect(migrationFiles().length).toBeGreaterThan(30);
  });

  it('no TypeScript outside the allowlist touches feature_flags', () => {
    const offenders = sourceFiles(['apps', 'packages'])
      .filter((rel) => !ALLOWED_TS.has(rel))
      // Test files are allowed to name the table when they are asserting about
      // it — including this one, which necessarily contains the string.
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8').includes(TABLE));

    expect(
      offenders,
      `These files query feature_flags directly:\n  ${offenders.join('\n  ')}\n\n` +
        `Call public.is_feature_enabled(org_id, key) instead. It ANDs the global row ` +
        `with the org row and is the only place that answers whether a capability is ` +
        `on. A second reader breaks that guarantee, and the quota trigger in ` +
        `20260826000001 exempts the global row on the strength of it.\n\n` +
        `If this reader genuinely does not make an authorization decision, add it to ` +
        `ALLOWED_TS with a sentence saying why.`
    ).toEqual([]);
  });

  it('no migration outside the allowlist reads feature_flags', () => {
    const offenders = migrationFiles()
      .filter((name) => !ALLOWED_SQL.has(name))
      .filter((name) =>
        SQL_READ.test(readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8'))
      );

    expect(
      offenders,
      `These migrations read feature_flags:\n  ${offenders.join('\n  ')}\n\n` +
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
