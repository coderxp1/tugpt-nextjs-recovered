/**
 * ADR-006 (2026-08-18): TuGPT runs on Langdock only.
 *
 *   - **Logicc** was cut entirely. Cost — billing was far too expensive.
 *   - **Anymize** was removed from TuGPT specifically. It is used on other
 *     projects, and calling it from here would couple the two and bleed usage
 *     between them. This one is not a preference; it is an isolation boundary.
 *
 * Both adapters are still implemented and still exported, on purpose:
 * reintroducing a fallback provider should be an import and a constructor
 * argument, not a rewrite. `DraftOrchestrator` already accepts `fallback` and
 * `tertiary`.
 *
 * WHY THIS FILE EXISTS
 *
 * Until now that decision lived entirely in prose — a comment block at the top
 * of `draft-orchestrator-factory.ts` saying "Do NOT import AnymizeAdapter into
 * this file for any reason". A comment is a good explanation and a bad
 * enforcement: it is invisible to anyone editing a different file, it does not
 * survive a refactor that moves the wiring somewhere else, and nothing fails
 * when it is ignored. The failure mode is silence, and the consequence is
 * calling another project's provider account from this one.
 *
 * So the rule is now mechanical. This scans the production source of every
 * package for either adapter and fails if one is imported or constructed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not check that the adapters are absent — they must stay. It does not
 * read prose, and it does not check ADR text: a checker that greps documents
 * for the right sentence is a checker that fails when somebody rewords a
 * sentence, which teaches people to write around it. It checks the one thing
 * that is both unambiguous and consequential: whether production code can
 * reach these two classes.
 *
 * `packages/ai-providers` is excluded because that is where they are defined
 * and exported. Test files are excluded because a test that exercises a cut
 * adapter is legitimate — it is wiring, not coverage, that ADR-006 forbids.
 *
 * Worth recording while writing this: `packages/ai-providers` currently has no
 * test files at all. Every adapter in the provider layer, including the one
 * production actually uses, is covered only indirectly through the worker's
 * orchestrator tests. That is a separate gap from this one and is not fixed
 * here, but it is the reason this guard checks imports rather than behaviour —
 * there is no adapter-level suite for it to hang off.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.join(process.cwd(), '..', '..');

/** The two adapters ADR-006 removed from the production chain. */
export const CUT_ADAPTERS = ['LogiccAdapter', 'AnymizeAdapter'] as const;

/**
 * Production source trees.
 *
 * This list must cover the `src` directory of every app and every package in
 * the repo, minus the exemptions below — asserted, because the cheapest way to
 * defeat this guard is to quietly shorten the list rather than argue with it.
 */
export const PRODUCTION_ROOTS = [
  'apps/worker/src',
  'apps/web/src',
  'packages/ai-orchestration/src',
  'packages/auth/src',
  'packages/database/src',
  'packages/feature-flags/src',
  'packages/jobs/src',
  'packages/observability/src',
  'packages/security/src',
];

/** Not scanned, with the reason. Anything else new must be classified. */
export const EXEMPT_ROOTS: Record<string, string> = {
  'packages/ai-providers/src': 'Defines and exports both adapters. That is its job.',
};

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo']);

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[cm]?tsx?$/.test(name);
}

/** Every non-test TypeScript file under `dir`, recursively. */
export function productionFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...productionFilesIn(path.join(dir, entry.name)));
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !isTestFile(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

export interface Reach {
  file: string;
  adapter: string;
  how: 'import' | 'construction';
  line: number;
}

/**
 * Ways production code could actually reach a cut adapter.
 *
 * Comments are stripped first. The factory's own comment block names both
 * adapters in order to explain why they are absent — scanning raw text would
 * flag the explanation as the violation, which is the kind of false positive
 * that gets a guard deleted.
 */
export function reachesIn(source: string, file = '<memory>'): Reach[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');

  const found: Reach[] = [];
  const lines = stripped.split('\n');

  for (const adapter of CUT_ADAPTERS) {
    // An import naming the class, in any of the shapes TypeScript allows.
    const imported = new RegExp(`\\bimport\\b[\\s\\S]*?\\b${adapter}\\b[\\s\\S]*?from\\s*['"]`, 'g');
    for (const m of stripped.matchAll(imported)) {
      found.push({
        file,
        adapter,
        how: 'import',
        line: stripped.slice(0, m.index).split('\n').length,
      });
    }

    // `new AnymizeAdapter(` and `new providers.AnymizeAdapter(` — the route a
    // namespace import would take around the check above.
    lines.forEach((text, i) => {
      if (new RegExp(`\\bnew\\s+(?:[A-Za-z_$][\\w$]*\\.)*${adapter}\\s*\\(`).test(text)) {
        found.push({ file, adapter, how: 'construction', line: i + 1 });
      }
    });
  }

  return found;
}

function scanProduction(): Reach[] {
  const hits: Reach[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const file of productionFilesIn(path.join(REPO_ROOT, root))) {
      hits.push(...reachesIn(readFileSync(file, 'utf8'), path.relative(REPO_ROOT, file)));
    }
  }
  return hits;
}

describe('production wiring never reaches a cut provider (ADR-006)', () => {
  it('scans a real, non-empty set of files (a cwd change must fail, not pass vacuously)', () => {
    // Both doc guards in this directory resolve paths from process.cwd(). Run
    // from the repo root instead of the package and they inspect nothing and
    // report success — a failure mode this project has already hit. The count
    // is asserted so that "found no violations" cannot mean "found no files".
    const counts = PRODUCTION_ROOTS.map((r) => ({
      root: r,
      n: productionFilesIn(path.join(REPO_ROOT, r)).length,
    }));
    for (const { root, n } of counts) {
      expect(n, `${root} should contain production sources`).toBeGreaterThan(0);
    }
    expect(counts.reduce((a, c) => a + c.n, 0)).toBeGreaterThan(20);
  });

  it('imports neither LogiccAdapter nor AnymizeAdapter anywhere in production source', () => {
    const hits = scanProduction();
    const readable = hits.map((h) => `${h.file}:${h.line} ${h.how} of ${h.adapter}`);

    // If this fails, the question is not "how do I silence it". Logicc was cut
    // on cost and Anymize is isolated from this project on purpose; reversing
    // either is a decision, and the decision is recorded in ADR-006 before the
    // import lands here.
    expect(readable, 'ADR-006: TuGPT runs on Langdock only').toEqual([]);
  });

  it('still exports both adapters, because reintroduction must stay cheap', () => {
    // The opposite failure: somebody "cleans up" the unused adapters and
    // reintroducing a fallback becomes a rewrite instead of an import. ADR-006
    // keeps them deliberately, so their absence is also a regression.
    const index = readFileSync(path.join(REPO_ROOT, 'packages/ai-providers/src/index.ts'), 'utf8');
    expect(index).toContain("export * from './logicc'");
    expect(index).toContain("export * from './anymize'");
    for (const f of ['logicc.ts', 'anymize.ts']) {
      expect(
        existsSync(path.join(REPO_ROOT, 'packages/ai-providers/src', f)),
        `packages/ai-providers/src/${f} must stay`
      ).toBe(true);
    }
  });

  it('the factory that does the wiring is reached through PRODUCTION_ROOTS', () => {
    // Through the roots, not by scanning that directory directly: dropping
    // 'apps/worker/src' from the list is the cheapest way to make this whole
    // file pass while checking nothing, and a direct scan would not notice.
    const scanned = PRODUCTION_ROOTS.flatMap((r) =>
      productionFilesIn(path.join(REPO_ROOT, r)).map((f) => path.relative(REPO_ROOT, f))
    );
    expect(scanned).toContain('apps/worker/src/draft-orchestrator-factory.ts');
  });

  it('covers every source tree in the repo, or names why not', () => {
    // The same defeat, generalised: a new package appears, nobody adds it here,
    // and the guard silently stops covering the place the next wiring lands.
    const discovered: string[] = [];
    for (const group of ['apps', 'packages']) {
      const base = path.join(REPO_ROOT, group);
      if (!existsSync(base)) continue;
      for (const pkg of readdirSync(base, { withFileTypes: true })) {
        if (!pkg.isDirectory() || SKIP_DIRS.has(pkg.name)) continue;
        const src = path.join(base, pkg.name, 'src');
        if (existsSync(src)) discovered.push(`${group}/${pkg.name}/src`);
      }
    }

    const covered = new Set([...PRODUCTION_ROOTS, ...Object.keys(EXEMPT_ROOTS)]);
    const unclassified = discovered.filter((d) => !covered.has(d));
    expect(unclassified, 'add to PRODUCTION_ROOTS, or to EXEMPT_ROOTS with a reason').toEqual([]);

    // And nothing listed that no longer exists, which would make a root look
    // covered when it is not there to cover.
    const dangling = [...covered].filter((c) => !discovered.includes(c));
    expect(dangling, 'listed source trees that do not exist').toEqual([]);

    // Every exemption states a reason. "Excluded" without one is how a list
    // like this turns into a place to hide things.
    for (const [root, why] of Object.entries(EXEMPT_ROOTS)) {
      expect(why.length, `${root} needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe('the checker itself', () => {
  // A checker nobody tests is the same failure one level up: it would report a
  // clean tree whether or not the tree is clean. These prove it can fail.

  it('catches a named import', () => {
    const hits = reachesIn(`import { AnymizeAdapter } from '@tugpt/ai-providers';`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adapter: 'AnymizeAdapter', how: 'import' });
  });

  it('catches an import split across lines, which is how this one would really arrive', () => {
    const hits = reachesIn(
      ['import {', '  ProviderError,', '  LogiccAdapter,', "} from '@tugpt/ai-providers';"].join('\n')
    );
    expect(hits.map((h) => h.adapter)).toEqual(['LogiccAdapter']);
  });

  it('catches an aliased import', () => {
    const hits = reachesIn(`import { AnymizeAdapter as Fallback } from '@tugpt/ai-providers';`);
    expect(hits).toHaveLength(1);
  });

  it('catches construction through a namespace import, which no import check would see', () => {
    const hits = reachesIn(
      [`import * as providers from '@tugpt/ai-providers';`, `const p = new providers.AnymizeAdapter({});`].join('\n')
    );
    expect(hits.map((h) => h.how)).toContain('construction');
  });

  it('does not flag the comment that explains why they are absent', () => {
    // The factory's header names both adapters to say why they are NOT here.
    // A raw text scan would call that explanation a violation, and the guard
    // would be deleted within a week.
    const hits = reachesIn(
      [
        '/**',
        ' * Logicc and Anymize remain implemented as adapters but are',
        ' * intentionally NOT imported here. Do NOT import AnymizeAdapter.',
        ' */',
        '// also not LogiccAdapter',
        `import { RotatingLangdockAdapter } from '@tugpt/ai-providers';`,
      ].join('\n')
    );
    expect(hits).toEqual([]);
  });

  it('does not flag the real factory as it stands today', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'apps/worker/src/draft-orchestrator-factory.ts'),
      'utf8'
    );
    expect(reachesIn(src, 'draft-orchestrator-factory.ts')).toEqual([]);
  });

  it('reports the file and line, so a failure says where to look', () => {
    const hits = reachesIn(`const x = 1;\nconst p = new LogiccAdapter({});`, 'apps/worker/src/x.ts');
    expect(hits[0]).toMatchObject({ file: 'apps/worker/src/x.ts', line: 2 });
  });

  it('finds a violation planted in a real directory tree', () => {
    // productionFilesIn + reachesIn together, against a fixture on disk —
    // because a walker with an unreachable branch would pass every test above
    // and still scan nothing in production.
    const dir = mkdtempSync(path.join(tmpdir(), 'cut-provider-'));
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'clean.ts'), `export const a = 1;\n`);
    writeFileSync(
      path.join(dir, 'nested', 'wired.ts'),
      `import { AnymizeAdapter } from '@tugpt/ai-providers';\nexport const p = new AnymizeAdapter({});\n`
    );
    // Excluded: a test file may use them, and node_modules is not ours.
    // The fixture borrows the name of a real test file on purpose. Inventing
    // one would put a nonexistent `*.test.ts` name into this source, and
    // `referenced-test-files-exist.test.ts` correctly reports that as a
    // dangling reference — it caught exactly that on this file's first run.
    writeFileSync(path.join(dir, 'nested', 'worker.test.ts'), `import { LogiccAdapter } from 'x';\n`);
    writeFileSync(path.join(dir, 'node_modules', 'dep.ts'), `import { LogiccAdapter } from 'x';\n`);

    const files = productionFilesIn(dir);
    expect(files.map((f) => path.relative(dir, f)).sort()).toEqual([
      'clean.ts',
      path.join('nested', 'wired.ts'),
    ]);

    const hits = files.flatMap((f) => reachesIn(readFileSync(f, 'utf8'), path.relative(dir, f)));
    expect(hits.map((h) => h.how).sort()).toEqual(['construction', 'import']);
  });
});
