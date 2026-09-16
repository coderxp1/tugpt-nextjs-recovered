/**
 * @file fixture-emails-are-reserved.test.ts
 * @description Test fixtures may only use email domains that are reserved for
 * exactly this, by RFC 2606.
 *
 * WHY THIS EXISTS
 *
 * Until 2026-08-31 the test suites used `owner@tugpt.ai`, `invitee_c@tugpt.ai`,
 * `test@test.com` and thirty-odd others — 43 addresses at two domains nobody
 * here controls. `tugpt.ai` was lost to someone else on 2026-08-28, and
 * `test.com` has always belonged to a stranger.
 *
 * Nothing in this repository sends mail, so no message was ever going to arrive
 * at either. The cost is subtler and it is real: a fixture address is the
 * example everyone copies. It travels from a pgTAP file into a seed script,
 * from a seed script into a demo tenant, and from a demo tenant into a real
 * invitation — and the first thing that actually sends is the first thing that
 * discovers the domain is a stranger's. The `tugpt.ai` migration is what a
 * cheap version of that lesson looks like.
 *
 * RFC 2606 exists so that this question has an answer: `example.com`,
 * `example.net`, `example.org`, and the `.test`, `.example`, `.invalid` and
 * `.localhost` TLDs are permanently reserved and can never be registered by
 * anyone. An address at one of them cannot become someone's mailbox later.
 *
 * WHY IT IS NOT `tugpt.app`
 *
 * That was the tempting fix in August and it is the wrong one. A real domain in
 * a fixture is the defect; swapping one real domain for another repeats it,
 * with a domain we would then also have to keep.
 *
 * SCOPE
 *
 * Test files only. Product copy is not a fixture — `auth.login.emailPlaceholder`
 * shows the reviewer what an address looks like, and that is a design decision
 * about the dictionaries, not a data-hygiene rule.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  scanFixtureEmails,
  isReservedEmailDomain as isReservedDomainHelper,
  extractEmails,
} from './helpers/architectural-guards';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOTS = ['apps', 'packages', 'supabase/tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', '.git', 'coverage']);

export const isReservedEmailDomain = isReservedDomainHelper;
export const emailsIn = extractEmails;

const EXEMPT = new Set([
  'apps/worker/tests/fixture-emails-are-reserved.test.ts',
  'apps/worker/tests/no-dead-domain.test.ts',
]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
  }
}

function testFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) walk(path.join(REPO_ROOT, root), out);
  return out.filter((f) => /\.test\.(ts|tsx|sql)$/.test(f)).filter((f) => !EXEMPT.has(f));
}

describe('the extractor', () => {
  it('T1: finds addresses, and only addresses', () => {
    expect(emailsIn("email: 'owner@example.com',")).toEqual(['owner@example.com']);
    expect(emailsIn("INSERT INTO users VALUES ('a@example.org');")).toEqual(['a@example.org']);
    expect(emailsIn('x@internal-e2e-test.invalid')).toEqual(['x@internal-e2e-test.invalid']);
  });

  it('T2: is not fooled by the things that look like addresses', () => {
    // Every one of these appears in this repository. A guard that flagged them
    // would be turned off within a week.
    expect(emailsIn("import { AuthService } from '@tugpt/auth';")).toEqual([]);
    expect(emailsIn('"packageManager": "pnpm@10.34.1"')).toEqual([]);
    expect(emailsIn("import x from '@testing-library/react';")).toEqual([]);
    expect(emailsIn('// @vitest-environment jsdom')).toEqual([]);
  });
});

describe('the reserved-domain rule', () => {
  it('T3: accepts every RFC 2606 form', () => {
    for (const d of ['example.com', 'example.net', 'example.org', 'mail.example.com']) {
      expect(isReservedEmailDomain(d), d).toBe(true);
    }
    for (const d of ['foo.test', 'foo.example', 'internal-e2e-test.invalid', 'localhost']) {
      expect(isReservedEmailDomain(d), d).toBe(true);
    }
  });

  it('T4: rejects the two domains that were actually in use here', () => {
    // Positive control, and the reason this file exists. Both of these were
    // fixture domains in this repository until 2026-08-31.
    expect(isReservedEmailDomain('tugpt.ai')).toBe(false);
    expect(isReservedEmailDomain('test.com')).toBe(false);
  });

  it('T5: rejects the tempting wrong fix', () => {
    // `tugpt.app` is ours and it resolves. A fixture address there is the same
    // defect as `tugpt.ai` was, with a domain we would then have to keep.
    expect(isReservedEmailDomain('tugpt.app')).toBe(false);
    // And a domain that merely contains a reserved word is not reserved.
    expect(isReservedEmailDomain('example.com.attacker.net')).toBe(false);
    expect(isReservedEmailDomain('nottest.io')).toBe(false);
  });
});

describe('every fixture address in the suite', () => {
  const files = testFiles();

  it('T6: found the test files it is checking', () => {
    // A moved root, or a changed test-file convention, must fail here rather
    // than quietly turn this into an assertion about nothing.
    expect(files.length, 'test file set looks empty — check ROOTS').toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('.sql')), 'no pgTAP files found').toBe(true);
  });

  it('T7: uses a domain reserved by RFC 2606', () => {
    const results = scanFixtureEmails(REPO_ROOT);
    const offenders = results.flatMap((r) => r.violations.map((v) => `${r.file}: ${v}`));

    expect(
      offenders,
      `Test fixtures must use RFC 2606 reserved domains — example.com/.net/.org, ` +
        `or a .test/.example/.invalid/.localhost name.\n  ${offenders.join('\n  ')}\n\n` +
        `Not tugpt.app: a real domain in a fixture is the defect, and swapping one ` +
        `real domain for another repeats it.`
    ).toEqual([]);
  });
});
