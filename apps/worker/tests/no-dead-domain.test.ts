/**
 * `tugpt.ai` is hostile. This keeps it from coming back.
 *
 * WHY A TEST AND NOT A CODE REVIEW
 *
 * On 2026-08-28 control of `tugpt.ai` was lost and `tugpt.app` became canonical.
 * The migration audit was done by hand, with grep, and grep missed two entire
 * categories on the first pass:
 *
 *   - `deploy/caddy/check-cert.test.sh` asserts on output with escaped regex —
 *     the file contains `tugpt\.ai`, so a literal search for `tugpt.ai` scored
 *     four fewer hits than there were.
 *   - `supabase/config.toml` carried `project_id = "tugpt-ai"`, spelled with a
 *     hyphen, which no search for the dotted form would ever surface.
 *
 * Both were found only because the fixtures went red and a second, looser sweep
 * was run. A one-time audit that needs two tries is not a control. This is.
 *
 * SCOPE: runtime and deployment paths only.
 *
 * Prose is deliberately out of scope. `docs/` and `docs/adr/` have to be able to
 * describe the incident, name the domain that was lost, and keep decision
 * records that were true when written — a guard that forbade the string there
 * would make the incident undocumentable, which is worse than the risk it
 * removes. What is guarded is everything that runs or deploys: application and
 * package source, deploy scripts, compose, systemd units, Supabase config.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Every spelling of the dead domain, including the ones the hand audit missed.
 *
 *   tugpt.ai    the hostname
 *   tugpt\.ai   the same, escaped inside a shell or JS regex
 *   tugpt-ai    identifier form (supabase config project_id)
 *   tugpt_ai    identifier form, other convention
 *
 * `@tugpt/ai-providers` and `@tugpt/ai-orchestration` are workspace package
 * names and must not match, which is what the trailing exclusion of `-` and `/`
 * is for.
 */
const DEAD_DOMAIN = /tugpt\\?[._-]ai(?![-a-z0-9])/i;

/** Directories that run or deploy. Prose lives elsewhere and is not guarded. */
const GUARDED_ROOTS = ['apps', 'packages', 'deploy', 'supabase'];

/** Individual files outside those roots that still ship or deploy. */
const GUARDED_FILES = ['docker-compose.yml', 'package.json', 'turbo.json'];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'coverage',
]);

/**
 * Files that may still contain it, and why. Every entry is a standing
 * instruction or a repository rule, not a convenience.
 *
 * Both survivors are files nobody is allowed to edit, and in both the hit is a
 * header comment naming the product — not a hostname anything resolves.
 *
 * There were ten entries. The other eight were fixture email addresses, parked
 * here on 2026-08-28 because the files were being modified on PR #47 and
 * rebasing a migration PR mid-review to change test data is the wrong trade.
 * They were changed to `example.com` on 2026-08-31 and their exemptions
 * deleted with them. An exemption list that only grows stops being a list of
 * exceptions and becomes the rule.
 */
const ALLOWED = new Map<string, string>([
  [
    'supabase/seed.sql',
    'Owner instruction, standing: the seed file is not to be modified. The hit ' +
      'is a header comment naming the product, not a hostname anything resolves.',
  ],
  [
    'supabase/migrations/20260716000001_initial_schema.sql',
    'An applied migration. docs/production_environment.md section 7: never edit a ' +
      'migration that has been applied — the CLI keys the ledger on the version ' +
      'timestamp and would not notice the change. Header comment only.',
  ],
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
    else out.push(path.relative(REPO_ROOT, full));
  }
}

function guardedFiles(): string[] {
  const out: string[] = [];
  for (const root of GUARDED_ROOTS) walk(path.join(REPO_ROOT, root), out);
  for (const f of GUARDED_FILES) out.push(f);
  return out;
}

/** Text-ish files only; a binary that happens to contain the bytes is noise. */
function isTextish(rel: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|sql|sh|ya?ml|toml|json|env|service|md|conf|Caddyfile)$/i.test(rel)
    || path.basename(rel) === 'Caddyfile';
}

describe('the dead domain does not come back', () => {
  it('finds the tree it is guarding (a moved root must fail loudly, not silently pass)', () => {
    const files = guardedFiles().filter(isTextish);
    expect(files.length, 'guarded file set looks empty — check GUARDED_ROOTS').toBeGreaterThan(80);
  });

  it('matches every spelling, including the two the hand audit missed', () => {
    // Positive controls. If the pattern stops catching these, the guard is
    // decorative and the next migration repeats 2026-08-28.
    expect(DEAD_DOMAIN.test('https://tugpt.ai/api/v1/health')).toBe(true);
    expect(DEAD_DOMAIN.test(String.raw`assert_matches 'ok +cert +tugpt\.ai valid'`)).toBe(true);
    expect(DEAD_DOMAIN.test('project_id = "tugpt-ai"')).toBe(true);
    expect(DEAD_DOMAIN.test('TUGPT_AI_THING')).toBe(true);
    expect(DEAD_DOMAIN.test('owner@tugpt.ai')).toBe(true);

    // Must NOT match: workspace package names.
    expect(DEAD_DOMAIN.test("import x from '@tugpt/ai-providers'")).toBe(false);
    expect(DEAD_DOMAIN.test("@tugpt/ai-orchestration@0.1.0")).toBe(false);
    // Must NOT match: the live domain.
    expect(DEAD_DOMAIN.test('https://tugpt.app/api/v1/health')).toBe(false);
  });

  it('no runtime or deploy file references it', () => {
    const offenders = guardedFiles()
      .filter(isTextish)
      .filter((rel) => !ALLOWED.has(rel))
      // These two necessarily contain the dead domain: it is the subject of
      // their positive controls. Exempted by exact path, not by a blanket
      // *.test.ts rule, so any other test that reintroduces the domain still
      // fails — which is how the pgTAP fixtures were caught in the first place.
      .filter(
        (rel) =>
          rel !== 'apps/worker/tests/no-dead-domain.test.ts' &&
          rel !== 'apps/worker/tests/fixture-emails-are-reserved.test.ts'
      )
      .filter((rel) => {
        try {
          return DEAD_DOMAIN.test(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
        } catch {
          return false;
        }
      });

    expect(
      offenders,
      `These runtime/deploy files still reference tugpt.ai:\n  ${offenders.join('\n  ')}\n\n` +
        `That domain is hostile — control of it was lost on 2026-08-28. Use tugpt.app, ` +
        `or for a product name use "TuGPT" with no TLD at all. Putting a TLD in the ` +
        `brand is what made this migration expensive; doing it again with .app ` +
        `guarantees a repeat.\n\n` +
        `If a hit genuinely cannot be changed, add it to ALLOWED with the standing ` +
        `instruction or repository rule that forbids the edit.`
    ).toEqual([]);
  });

  it('every allowlist entry still exists and still matches', () => {
    const stale: string[] = [];
    for (const rel of ALLOWED.keys()) {
      let content: string;
      try {
        content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      if (!DEAD_DOMAIN.test(content)) stale.push(`${rel} (cleaned up — remove the exemption)`);
    }
    expect(
      stale,
      `Stale exemptions:\n  ${stale.join('\n  ')}\n\nThe follow-up PR that cleans the ` +
        `fixture emails should shrink this list, not leave it.`
    ).toEqual([]);
  });
});
