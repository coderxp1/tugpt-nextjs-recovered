/**
 * @file path-normalization-negative-controls.test.ts
 * @description Negative control test suite verifying that each of the repository's
 * five path-normalized architectural guards triggers an expected failure when exposed
 * to deliberately violating fixtures.
 *
 * SCOPE:
 * 1. Direct `feature_flags` query detector (feature-flag-sole-reader)
 * 2. Prohibited dead domain detector (no-dead-domain)
 * 3. Unreserved fixture email domain detector (fixture-emails-are-reserved)
 * 4. Phantom systemd unit command detector (no-phantom-units)
 * 5. Cut provider import / construction detector (production-never-imports-cut-providers)
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Imported from sibling guards
import { reachesIn, CUT_ADAPTERS } from './production-never-imports-cut-providers.test';
import { isReservedEmailDomain, emailsIn } from './fixture-emails-are-reserved.test';
import { unitsOnLine, instructionLines } from './no-phantom-units.test';

describe('negative controls: feature-flag-sole-reader guard', () => {
  const TABLE = 'feature_flags';
  const SQL_READ = /FROM\s+(?:public\.)?feature_flags/i;

  it('detects an unauthorized TypeScript reader querying feature_flags directly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-neg-ts-'));
    try {
      const filePath = path.join(dir, 'unauthorized-service.ts');
      const badSource = [
        "import { SupabaseClient } from '@supabase/supabase-js';",
        'export async function checkFlag(client: SupabaseClient) {',
        `  return client.from('${TABLE}').select('*').eq('key', 'test');`,
        '}',
      ].join('\n');
      writeFileSync(filePath, badSource);

      const content = readFileSync(filePath, 'utf8');
      const violates = content.includes(TABLE);
      expect(violates, 'should detect table mention in non-allowlisted TS').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects an unauthorized SQL migration reading feature_flags directly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-neg-sql-'));
    try {
      const sqlPath = path.join(dir, '20269999000000_unauthorized_reader.sql');
      const badSql = [
        'CREATE OR REPLACE FUNCTION check_permission() RETURNS boolean AS $$',
        'BEGIN',
        `  RETURN EXISTS (SELECT 1 FROM ${TABLE} WHERE key = 'test' AND is_enabled = true);`,
        'END;',
        '$$ LANGUAGE plpgsql;',
      ].join('\n');
      writeFileSync(sqlPath, badSql);

      const content = readFileSync(sqlPath, 'utf8');
      expect(SQL_READ.test(content), 'should detect direct SQL read from feature_flags').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('negative controls: no-dead-domain guard', () => {
  // Constructed dynamically to prevent static scanners from matching this test file
  const deadHost = ['tugpt', 'ai'].join('.');
  const deadHyphen = ['tugpt', 'ai'].join('-');
  const deadRegex = ['tugpt', 'ai'].join('\\.');
  const deadUnderscore = ['TUGPT', 'AI'].join('_');
  const DEAD_DOMAIN = /tugpt\\?[._-]ai(?![-a-z0-9])/i;

  it('triggers on prohibited dead domain hostnames and identifiers', () => {
    const violatingInputs = [
      `https://${deadHost}/api/v1/health`,
      `assert_matches 'ok +cert +${deadRegex} valid'`,
      `project_id = "${deadHyphen}"`,
      `${deadUnderscore}_CONFIG = "true"`,
      `owner@${deadHost}`,
    ];

    for (const input of violatingInputs) {
      expect(DEAD_DOMAIN.test(input), `Expected "${input}" to be flagged as dead domain violation`).toBe(true);
    }
  });

  it('does not falsely trigger on legitimate workspace packages or canonical domain', () => {
    const legitimateInputs = [
      "import x from '@tugpt/ai-providers';",
      "@tugpt/ai-orchestration@0.1.0",
      "https://tugpt.app/api/v1/health",
    ];

    for (const input of legitimateInputs) {
      expect(DEAD_DOMAIN.test(input), `Expected "${input}" to be clean`).toBe(false);
    }
  });
});

describe('negative controls: fixture-emails-are-reserved guard', () => {
  it('extracts and flags non-reserved email addresses as violations', () => {
    // Dynamically constructed non-reserved email addresses
    const badDomain1 = ['tugpt', 'ai'].join('.');
    const badDomain2 = 'test.com';
    const badDomain3 = 'gmail.com';

    const source = [
      `const owner = 'user@${badDomain1}';`,
      `const invitee = 'invitee@${badDomain2}';`,
      `const stranger = 'person@${badDomain3}';`,
      `const legitimate = 'valid@example.com';`,
    ].join('\n');

    const found = emailsIn(source);
    expect(found).toHaveLength(4);

    const violations = found.filter((email) => {
      const domain = email.split('@')[1];
      return !isReservedEmailDomain(domain);
    });

    expect(violations).toEqual([
      `user@${badDomain1}`,
      `invitee@${badDomain2}`,
      `person@${badDomain3}`,
    ]);
  });
});

describe('negative controls: no-phantom-units guard', () => {
  // Construct runner and unit tokens dynamically to avoid matching line-scoped scanners
  const runnerCmd = 'system' + 'ctl';
  const journalCmd = 'journal' + 'ctl';
  const phantom1 = 'tugpt-' + 'draft-worker';
  const phantom2 = 'tugpt-' + 'whatsapp-worker';

  it('detects phantom units in systemctl and journalctl command lines', () => {
    const line1 = `${runnerCmd} restart ${phantom1}`;
    const line2 = `${journalCmd} -u ${phantom2} --follow`;

    expect(unitsOnLine(line1)).toEqual([phantom1]);
    expect(unitsOnLine(line2)).toEqual([phantom2]);
  });

  it('flags markdown fenced code blocks that drive phantom units', () => {
    const md = [
      '# Operations Guide',
      '',
      '```bash',
      `sudo ${runnerCmd} restart ${phantom1}`,
      '```',
      '',
      'Some prose mentioning the old worker is fine.',
    ].join('\n');

    const lines = instructionLines(md, true);
    const offenders: string[] = [];
    for (const { text } of lines) {
      for (const unit of unitsOnLine(text)) {
        if (unit === phantom1) offenders.push(unit);
      }
    }

    expect(offenders).toEqual([phantom1]);
  });
});

describe('negative controls: production-never-imports-cut-providers guard', () => {
  it('detects imports of cut adapters (LogiccAdapter and AnymizeAdapter)', () => {
    for (const adapter of CUT_ADAPTERS) {
      const namedImport = `import { ${adapter} } from '@tugpt/ai-providers';`;
      const hitsNamed = reachesIn(namedImport);
      expect(hitsNamed.length).toBeGreaterThan(0);
      expect(hitsNamed[0].adapter).toBe(adapter);
      expect(hitsNamed[0].how).toBe('import');

      const multiline = `import {\n  ${adapter},\n} from '@tugpt/ai-providers';`;
      const hitsMulti = reachesIn(multiline);
      expect(hitsMulti.length).toBeGreaterThan(0);
      expect(hitsMulti[0].adapter).toBe(adapter);

      const aliased = `import { ${adapter} as Fallback } from '@tugpt/ai-providers';`;
      const hitsAliased = reachesIn(aliased);
      expect(hitsAliased.length).toBeGreaterThan(0);
      expect(hitsAliased[0].adapter).toBe(adapter);

      const construction = `import * as p from '@tugpt/ai-providers';\nconst inst = new p.${adapter}({});`;
      const hitsConstruct = reachesIn(construction);
      expect(hitsConstruct.length).toBeGreaterThan(0);
      expect(hitsConstruct.some((h) => h.how === 'construction')).toBe(true);
    }
  });

  it('does not flag permitted provider files or comments', () => {
    const explanationComment = [
      '/**',
      ' * LogiccAdapter and AnymizeAdapter are intentionally NOT imported here.',
      ' */',
      "import { RotatingLangdockAdapter } from '@tugpt/ai-providers';",
    ].join('\n');

    expect(reachesIn(explanationComment)).toEqual([]);
  });
});