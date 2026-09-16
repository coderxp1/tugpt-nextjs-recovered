/**
 * @file architectural-guards.ts
 * @description Shared, non-test scanner helpers implementing repository traversal,
 * path-separator normalization, and allowlist validation for architectural invariants.
 *
 * Used by both the primary test guards and the negative control test suites.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'coverage',
]);

/** Normalize relative filesystem paths to POSIX forward slashes. */
export function normalizePath(rel: string): string {
  return rel.split(path.sep).join('/');
}

// -----------------------------------------------------------------------------
// 1. Feature Flag Sole Reader Scanner
// -----------------------------------------------------------------------------

export const FEATURE_FLAG_TABLE = ['feature', 'flags'].join('_');
export const FEATURE_FLAG_SQL_READ = new RegExp(
  ['FROM\\s+(?:public\\.)?', 'feature', '_flags'].join(''),
  'i'
);

export const DEFAULT_ALLOWED_TS_FLAGS = new Map<string, string>([
  [
    'packages/database/src/types.ts',
    'Generated Supabase type map. Declares the table shape; performs no query.',
  ],
  [
    'apps/worker/src/e2e/milestone1.ts',
    'E2E harness. Arms the global row and an org row as test setup, then restores them on teardown.',
  ],
]);

export const DEFAULT_ALLOWED_SQL_FLAGS = new Map<string, string>([
  [
    '20260805000013_create_is_feature_enabled_rpc.sql',
    'Defines is_feature_enabled. This is the sanctioned reader.',
  ],
  [
    '20260826000001_draft_quota_period_lifecycle.sql',
    'enable_draft_generation_for_org reads the global row to REPORT it as output.',
  ],
]);

export function findSourceFiles(repoRoot: string, roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(normalizePath(path.relative(repoRoot, full)));
      }
    }
  };
  for (const root of roots) walk(path.join(repoRoot, root));
  return out;
}

export function scanFeatureFlags(
  repoRoot: string,
  options?: {
    allowedTs?: Map<string, string>;
    allowedSql?: Map<string, string>;
    roots?: string[];
    migrationDir?: string;
  }
): { tsViolations: string[]; sqlViolations: string[] } {
  const allowedTs = options?.allowedTs ?? DEFAULT_ALLOWED_TS_FLAGS;
  const allowedSql = options?.allowedSql ?? DEFAULT_ALLOWED_SQL_FLAGS;
  const roots = options?.roots ?? ['apps', 'packages'];
  const migDir = options?.migrationDir ?? path.join(repoRoot, 'supabase', 'migrations');

  const tsViolations = findSourceFiles(repoRoot, roots)
    .filter((rel) => !allowedTs.has(rel))
    .filter((rel) => !/\.test\.tsx?$/.test(rel) && !/\/tests?\//.test(rel))
    .filter((rel) => {
      try {
        return readFileSync(path.join(repoRoot, rel), 'utf8').includes(FEATURE_FLAG_TABLE);
      } catch {
        return false;
      }
    });

  let sqlFiles: string[] = [];
  try {
    sqlFiles = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    sqlFiles = [];
  }

  const sqlViolations = sqlFiles
    .filter((name) => !allowedSql.has(name))
    .filter((name) => {
      try {
        return FEATURE_FLAG_SQL_READ.test(readFileSync(path.join(migDir, name), 'utf8'));
      } catch {
        return false;
      }
    });

  return { tsViolations, sqlViolations };
}

// -----------------------------------------------------------------------------
// 2. Dead Domain Scanner
// -----------------------------------------------------------------------------

// Constructed dynamically to prevent static scanners from self-matching
export const DEAD_DOMAIN_PATTERN = new RegExp(
  ['tugpt', '\\\\?[._-]ai(?![-a-z0-9])'].join(''),
  'i'
);

export const DEFAULT_DEAD_DOMAIN_ALLOWED = new Map<string, string>([
  [
    'supabase/seed.sql',
    'Owner instruction, standing: header comment naming the product.',
  ],
  [
    'supabase/migrations/20260716000001_initial_schema.sql',
    'Applied migration: header comment only.',
  ],
]);

export function isTextishFile(rel: string): boolean {
  return (
    /\.(ts|tsx|js|jsx|mjs|cjs|sql|sh|ya?ml|toml|json|env|service|md|conf|Caddyfile)$/i.test(rel) ||
    path.basename(rel) === 'Caddyfile'
  );
}

export function scanDeadDomains(
  repoRoot: string,
  options?: {
    allowed?: Map<string, string>;
    guardedRoots?: string[];
    guardedFiles?: string[];
    exemptFiles?: Set<string>;
  }
): string[] {
  const allowed = options?.allowed ?? DEFAULT_DEAD_DOMAIN_ALLOWED;
  const guardedRoots = options?.guardedRoots ?? ['apps', 'packages', 'deploy', 'supabase'];
  const guardedFiles = options?.guardedFiles ?? ['docker-compose.yml', 'package.json', 'turbo.json'];
  const exemptFiles = options?.exemptFiles ?? new Set([
    'apps/worker/tests/no-dead-domain.test.ts',
    'apps/worker/tests/fixture-emails-are-reserved.test.ts',
  ]);

  const allFiles: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else allFiles.push(normalizePath(path.relative(repoRoot, full)));
    }
  };

  for (const root of guardedRoots) {
    walk(path.join(repoRoot, root));
  }
  for (const f of guardedFiles) {
    if (existsSync(path.join(repoRoot, f))) {
      allFiles.push(normalizePath(f));
    }
  }

  return allFiles
    .filter(isTextishFile)
    .filter((rel) => !allowed.has(rel))
    .filter((rel) => !exemptFiles.has(rel))
    .filter((rel) => {
      try {
        return DEAD_DOMAIN_PATTERN.test(readFileSync(path.join(repoRoot, rel), 'utf8'));
      } catch {
        return false;
      }
    });
}

// -----------------------------------------------------------------------------
// 3. Fixture Emails Reserved Scanner
// -----------------------------------------------------------------------------

export const RESERVED_EMAIL_TLDS = ['test', 'example', 'invalid', 'localhost'];
export const RESERVED_EMAIL_DOMAINS = ['example.com', 'example.net', 'example.org'];

export function isReservedEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (RESERVED_EMAIL_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`))) return true;
  return RESERVED_EMAIL_TLDS.some((t) => d === t || d.endsWith(`.${t}`));
}

export function extractEmails(source: string): string[] {
  return source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? [];
}

export function scanFixtureEmails(
  repoRoot: string,
  options?: {
    exempt?: Set<string>;
    roots?: string[];
  }
): { file: string; violations: string[] }[] {
  const exempt = options?.exempt ?? new Set([
    'apps/worker/tests/fixture-emails-are-reserved.test.ts',
    'apps/worker/tests/no-dead-domain.test.ts',
  ]);
  const roots = options?.roots ?? ['apps', 'packages', 'supabase/tests'];

  const testFiles: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else {
        const rel = normalizePath(path.relative(repoRoot, full));
        if (/\.test\.(ts|tsx|sql)$/.test(rel) && !exempt.has(rel)) {
          testFiles.push(rel);
        }
      }
    }
  };

  for (const r of roots) walk(path.join(repoRoot, r));

  const results: { file: string; violations: string[] }[] = [];
  for (const rel of testFiles) {
    let content = '';
    try {
      content = readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const emails = extractEmails(content);
    const unreserved = emails.filter((e) => {
      const domain = e.split('@')[1];
      return !isReservedEmailDomain(domain);
    });
    if (unreserved.length > 0) {
      results.push({ file: rel, violations: unreserved });
    }
  }

  return results;
}

// -----------------------------------------------------------------------------
// 4. No Phantom Units Scanner
// -----------------------------------------------------------------------------

export const PHANTOM_RUNNER_PATTERN = /systemctl|journalctl/i;
export const PHANTOM_UNIT_TOKEN_PATTERN = /\btugpt-[a-z0-9-]+/g;

export function getRealUnits(systemdDir: string): Set<string> {
  try {
    const units = readdirSync(systemdDir)
      .filter((f) => f.endsWith('.service'))
      .map((f) => f.replace(/\.service$/, ''));
    return new Set(units);
  } catch {
    return new Set();
  }
}

export function extractUnitsOnLine(text: string): string[] {
  if (!PHANTOM_RUNNER_PATTERN.test(text)) return [];
  return [...text.matchAll(PHANTOM_UNIT_TOKEN_PATTERN)].map((m) => m[0]);
}

export function extractInstructionLines(content: string, fencedOnly: boolean): { line: number; text: string }[] {
  const lines = content.split('\n');
  if (!fencedOnly) return lines.map((text, i) => ({ line: i + 1, text }));

  const out: { line: number; text: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push({ line: i + 1, text });
  }
  return out;
}

export function scanPhantomUnits(
  repoRoot: string,
  options?: {
    allowed?: Map<string, string>;
    realUnitsSet?: Set<string>;
    systemdDir?: string;
  }
): { file: string; line: number; unit: string; text: string }[] {
  const allowed = options?.allowed ?? new Map([
    ['deploy/check-host.sh', 'Asserts units are NOT enabled'],
  ]);
  const systemdDir = options?.systemdDir ?? path.join(repoRoot, 'deploy', 'systemd');
  const units = options?.realUnitsSet ?? getRealUnits(systemdDir);

  const searchRoots = [
    { dir: 'docs', exts: ['.md'], fencedOnly: true },
    { dir: 'deploy', exts: ['.sh'], fencedOnly: false },
    { dir: 'apps', exts: ['.ts', '.tsx'], fencedOnly: false },
    { dir: 'packages', exts: ['.ts', '.tsx'], fencedOnly: false },
  ];

  const violations: { file: string; line: number; unit: string; text: string }[] = [];

  for (const root of searchRoots) {
    const dir = path.join(repoRoot, root.dir);
    if (!existsSync(dir)) continue;

    const files: string[] = [];
    const walk = (d: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = path.join(d, entry);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(full);
        else if (root.exts.some((e) => full.endsWith(e))) {
          files.push(normalizePath(path.relative(repoRoot, full)));
        }
      }
    };
    walk(dir);

    for (const rel of files) {
      if (rel === 'apps/worker/tests/no-phantom-units.test.ts' || allowed.has(rel)) continue;
      let content = '';
      try {
        content = readFileSync(path.join(repoRoot, rel), 'utf8');
      } catch {
        continue;
      }
      for (const { line, text } of extractInstructionLines(content, root.fencedOnly)) {
        for (const unit of extractUnitsOnLine(text)) {
          if (!units.has(unit)) {
            violations.push({ file: rel, line, unit, text: text.trim() });
          }
        }
      }
    }
  }

  return violations;
}

// -----------------------------------------------------------------------------
// 5. Cut Providers Scanner
// -----------------------------------------------------------------------------

export const CUT_ADAPTERS = ['LogiccAdapter', 'AnymizeAdapter'] as const;

export const DEFAULT_PRODUCTION_ROOTS = [
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

export const DEFAULT_EXEMPT_ROOTS: Record<string, string> = {
  'packages/ai-providers/src': 'Defines and exports both adapters. That is its job.',
};

export interface ReachRecord {
  file: string;
  adapter: string;
  how: 'import' | 'construction';
  line: number;
}

export function reachesInSource(source: string, file = '<memory>'): ReachRecord[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');

  const found: ReachRecord[] = [];
  const lines = stripped.split('\n');

  for (const adapter of CUT_ADAPTERS) {
    const imported = new RegExp(`\\bimport\\b[\\s\\S]*?\\b${adapter}\\b[\\s\\S]*?from\\s*['"]`, 'g');
    for (const m of stripped.matchAll(imported)) {
      found.push({
        file,
        adapter,
        how: 'import',
        line: stripped.slice(0, m.index).split('\n').length,
      });
    }

    lines.forEach((text, i) => {
      if (new RegExp(`\\bnew\\s+(?:[A-Za-z_$][\\w$]*\\.)*${adapter}\\s*\\(`).test(text)) {
        found.push({ file, adapter, how: 'construction', line: i + 1 });
      }
    });
  }

  return found;
}

export function scanCutProviders(
  repoRoot: string,
  options?: {
    productionRoots?: string[];
  }
): ReachRecord[] {
  const roots = options?.productionRoots ?? DEFAULT_PRODUCTION_ROOTS;
  const hits: ReachRecord[] = [];

  const walk = (dir: string, out: string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, out);
      else if (/\.[cm]?tsx?$/.test(entry) && !/\.(test|spec)\.[cm]?tsx?$/.test(entry)) {
        out.push(normalizePath(path.relative(repoRoot, full)));
      }
    }
  };

  for (const root of roots) {
    const dir = path.join(repoRoot, root);
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    walk(dir, files);
    for (const rel of files) {
      let content = '';
      try {
        content = readFileSync(path.join(repoRoot, rel), 'utf8');
      } catch {
        continue;
      }
      hits.push(...reachesInSource(content, rel));
    }
  }

  return hits;
}