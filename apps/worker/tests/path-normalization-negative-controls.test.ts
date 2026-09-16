/**
 * @file path-normalization-negative-controls.test.ts
 * @description Negative control test suite verifying that each of the repository's
 * five path-normalized architectural guards triggers an expected failure when exposed
 * to deliberately violating fixtures on disk across relevant path forms.
 *
 * All scanner helpers are imported exclusively from the non-test module
 * `apps/worker/tests/helpers/architectural-guards.ts` to avoid re-registering test suites.
 *
 * SCOPE:
 * 1. Direct `feature_flags` query detector (scanFeatureFlags)
 * 2. Prohibited dead domain detector (scanDeadDomains)
 * 3. Unreserved fixture email domain detector (scanFixtureEmails)
 * 4. Phantom systemd unit command detector (scanPhantomUnits)
 * 5. Cut provider import / construction detector (scanCutProviders)
 * 6. Path-separator normalization guarantees across platforms
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  scanFeatureFlags,
  scanDeadDomains,
  scanFixtureEmails,
  scanPhantomUnits,
  scanCutProviders,
  normalizePath,
} from './helpers/architectural-guards';

describe('negative controls: feature-flag-sole-reader guard', () => {
  it('detects unauthorized TypeScript reader and SQL migration querying feature_flags directly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-neg-disk-'));
    try {
      const srcDir = path.join(dir, 'apps', 'worker', 'src');
      const migDir = path.join(dir, 'supabase', 'migrations');
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(migDir, { recursive: true });

      const badTs = [
        "import { SupabaseClient } from '@supabase/supabase-js';",
        'export async function checkFlag(client: SupabaseClient) {',
        "  return client.from('feature' + '_flags').select('*').eq('key', 'test');",
        '}',
      ].join('\n');
      writeFileSync(path.join(srcDir, 'violating-service.ts'), badTs.replace("('feature' + '_flags')", "('feature_flags')"));

      const badSql = [
        'CREATE OR REPLACE FUNCTION check_permission() RETURNS boolean AS $$',
        'BEGIN',
        '  RETURN EXISTS (SELECT 1 FROM public.feature_flags WHERE key = \'test\' AND is_enabled = true);',
        'END;',
        '$$ LANGUAGE plpgsql;',
      ].join('\n');
      writeFileSync(path.join(migDir, '20269999000000_unauthorized_reader.sql'), badSql);

      const { tsViolations, sqlViolations } = scanFeatureFlags(dir, {
        roots: ['apps'],
        migrationDir: migDir,
      });

      expect(tsViolations).toEqual(['apps/worker/src/violating-service.ts']);
      expect(sqlViolations).toEqual(['20269999000000_unauthorized_reader.sql']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('negative controls: no-dead-domain guard', () => {
  // Dynamically constructed tokens to prevent scanner self-matching
  const deadHost = ['tugpt', 'ai'].join('.');
  const deadHyphen = ['tugpt', 'ai'].join('-');
  const deadRegex = ['tugpt', 'ai'].join('\\.');
  const deadUnderscore = ['TUGPT', 'AI'].join('_');

  it('detects dead domain occurrences across apps, deploy, supabase, and compose files on disk', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dead-domain-disk-'));
    try {
      const appDir = path.join(dir, 'apps', 'worker', 'src');
      const deployDir = path.join(dir, 'deploy');
      const migDir = path.join(dir, 'supabase', 'migrations');
      mkdirSync(appDir, { recursive: true });
      mkdirSync(deployDir, { recursive: true });
      mkdirSync(migDir, { recursive: true });

      writeFileSync(path.join(appDir, 'bad-endpoint.ts'), `export const url = "https://${deadHost}/api";\n`);
      writeFileSync(path.join(deployDir, 'bad-cert.sh'), `assert_matches 'ok +cert +${deadRegex} valid'\n`);
      writeFileSync(path.join(migDir, 'bad-config.sql'), `INSERT INTO config VALUES ('${deadHyphen}');\n`);
      writeFileSync(path.join(dir, 'docker-compose.yml'), `services:\n  web:\n    image: ${deadUnderscore}:latest\n`);

      const violations = scanDeadDomains(dir, {
        guardedRoots: ['apps', 'deploy', 'supabase'],
        guardedFiles: ['docker-compose.yml'],
      });

      expect(violations.sort()).toEqual([
        'apps/worker/src/bad-endpoint.ts',
        'deploy/bad-cert.sh',
        'docker-compose.yml',
        'supabase/migrations/bad-config.sql',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('negative controls: fixture-emails-are-reserved guard', () => {
  it('detects unreserved fixture emails in test files across on-disk fixture trees', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'emails-neg-disk-'));
    try {
      const workerTests = path.join(dir, 'apps', 'worker', 'tests');
      const sqlTests = path.join(dir, 'supabase', 'tests');
      mkdirSync(workerTests, { recursive: true });
      mkdirSync(sqlTests, { recursive: true });

      const badDomain1 = ['tugpt', 'ai'].join('.');
      const unreservedEmail1 = ['invitee', 'test.com'].join('@');
      const unreservedEmail2 = ['stranger', 'gmail.com'].join('@');
      const testFileName = ['fixture-unreserved', 'test', 'ts'].join('.');
      const badTs = [
        `const owner = 'user@${badDomain1}';`,
        `const invitee = '${unreservedEmail1}';`,
        "const legitimate = 'valid@example.com';",
      ].join('\n');
      writeFileSync(path.join(workerTests, testFileName), badTs);

      const badSql = `INSERT INTO users VALUES ('${unreservedEmail2}'), ('admin@localhost');`;
      writeFileSync(path.join(sqlTests, 'violating.test.sql'), badSql);

      const results = scanFixtureEmails(dir, {
        roots: ['apps', 'supabase/tests'],
      });

      const mapped = results.map((r) => ({
        file: r.file,
        violations: r.violations.sort(),
      }));

      expect(mapped).toEqual([
        {
          file: `apps/worker/tests/${testFileName}`,
          violations: [unreservedEmail1, `user@${badDomain1}`].sort(),
        },
        {
          file: 'supabase/tests/violating.test.sql',
          violations: [unreservedEmail2],
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('negative controls: no-phantom-units guard', () => {
  it('detects phantom systemd unit commands in deployment scripts and docs on disk', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'units-neg-disk-'));
    try {
      const systemdDir = path.join(dir, 'deploy', 'systemd');
      const docsDir = path.join(dir, 'docs');
      mkdirSync(systemdDir, { recursive: true });
      mkdirSync(docsDir, { recursive: true });

      // Real unit in systemd
      writeFileSync(path.join(systemdDir, 'tugpt.service'), '[Unit]\nDescription=Real Unit\n');

      // Violating shell script
      const runnerCmd = 'system' + 'ctl';
      const journalCmd = 'journal' + 'ctl';
      const phantom1 = 'tugpt-' + 'draft-worker';
      const phantom2 = 'tugpt-' + 'whatsapp-worker';

      writeFileSync(
        path.join(dir, 'deploy', 'bad-rollout.sh'),
        `#!/bin/bash\n${runnerCmd} restart ${phantom1}\n`
      );

      // Violating markdown document with fenced code
      const badMd = [
        '# Operations Runbook',
        '',
        '```bash',
        `${journalCmd} -u ${phantom2} --follow`,
        '```',
        '',
        'Prose naming the phantom unit tugpt-draft-worker is not an instruction.',
      ].join('\n');
      writeFileSync(path.join(docsDir, 'runbook.md'), badMd);

      const violations = scanPhantomUnits(dir, { systemdDir });

      expect(violations).toEqual([
        {
          file: 'docs/runbook.md',
          line: 4,
          unit: phantom2,
          text: `${journalCmd} -u ${phantom2} --follow`,
        },
        {
          file: 'deploy/bad-rollout.sh',
          line: 2,
          unit: phantom1,
          text: `${runnerCmd} restart ${phantom1}`,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('negative controls: production-never-imports-cut-providers guard', () => {
  it('detects import and construction of LogiccAdapter and AnymizeAdapter in production sources', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'providers-neg-disk-'));
    try {
      const srcDir = path.join(dir, 'apps', 'worker', 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        path.join(srcDir, 'bad-import.ts'),
        "import { LogiccAdapter } from '@tugpt/ai-providers';\nexport const x = 1;\n"
      );

      writeFileSync(
        path.join(srcDir, 'bad-construction.ts'),
        "import * as providers from '@tugpt/ai-providers';\nconst a = new providers.AnymizeAdapter({});\n"
      );

      writeFileSync(
        path.join(srcDir, 'clean-comment.ts'),
        "/**\n * LogiccAdapter and AnymizeAdapter are excluded.\n */\nexport const ok = true;\n"
      );

      const hits = scanCutProviders(dir, {
        productionRoots: ['apps/worker/src'],
      });

      expect(hits).toHaveLength(2);
      expect(hits).toContainEqual({
        file: 'apps/worker/src/bad-import.ts',
        adapter: 'LogiccAdapter',
        how: 'import',
        line: 1,
      });
      expect(hits).toContainEqual({
        file: 'apps/worker/src/bad-construction.ts',
        adapter: 'AnymizeAdapter',
        how: 'construction',
        line: 2,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('path normalization: platform-invariant path separators', () => {
  it('normalizes Windows backslashes to POSIX forward slashes', () => {
    expect(normalizePath('apps\\worker\\src\\service.ts')).toBe('apps/worker/src/service.ts');
    expect(normalizePath('deploy\\staging\\launch-staging.sh')).toBe('deploy/staging/launch-staging.sh');
    expect(normalizePath('supabase\\migrations\\20260805000013.sql')).toBe('supabase/migrations/20260805000013.sql');
  });
});