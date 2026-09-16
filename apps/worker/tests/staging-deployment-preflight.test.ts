/**
 * @file staging-deployment-preflight.test.ts
 * @description Validates the runtime-only staging manifest, Compose-resolved structure,
 * preflight environment validation, and administrator launcher acceptance.
 *
 * GOVERNANCE AND INVARIANTS (ADR-018):
 * 1. Runtime-only: docker-compose.staging.yml must NOT contain build blocks.
 * 2. Immutable image: TUGPT_WEB_STAGING_IMAGE requires an approved @sha256: digest without fallback.
 * 3. Host isolation: Staging web binds strictly to 127.0.0.1:3002 (never 0.0.0.0, avoiding 3001 and 8188).
 * 4. Queue protection: Production queue workers are strictly EXCLUDED from staging.
 * 5. Zero GPU devices: GPU moratorium active, no devices reserved.
 * 6. Environment preflight:
 *    - TUGPT_ENVIRONMENT must be staging.
 *    - Supabase URL must match approved staging format and not match production ref.
 *    - Runtime NEXT_PUBLIC_* must match build-time image metadata.
 *    - All TUGPT_SECRET_KEY_* variables strictly rejected (even if empty).
 * 7. Launcher invariants:
 *    - Aborts if bundle or env file is missing.
 *    - Aborts before Docker is touched if preflight fails.
 *    - Scrubs inherited ambient environment.
 *    - Data-only parsing (no command injection).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STAGING_COMPOSE = path.join(REPO_ROOT, 'docker-compose.staging.yml');
const PREFLIGHT_SCRIPT = path.join(REPO_ROOT, 'deploy', 'staging', 'check-staging-env.sh');
const LAUNCHER_SCRIPT = path.join(REPO_ROOT, 'deploy', 'staging', 'launch-staging.sh');
const RELEASE_MANIFEST = path.join(REPO_ROOT, 'deploy', 'staging', 'release-manifest.json');

const APPROVED_DIGEST = 'sha256:0ad074799abb27b96cc85c3e31ac50f9ee417595fff2e29088a3a093e634e54e';
const APPROVED_IMAGE = `tugpt-web@${APPROVED_DIGEST}`;
const APPROVED_URL = 'https://staging.example.supabase.co';
const APPROVED_ANON_KEY = 'synthetic-staging-anon-key';

/** Locate a working POSIX sh executable across Linux/macOS and Windows environments. */
function findSh(): string {
  const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['sh']);
  if (which.status === 0 && which.stdout.toString().trim()) {
    return which.stdout.toString().trim().split('\n')[0].trim();
  }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\sh.exe',
      'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
      'C:\\Program Files (x86)\\Git\\bin\\sh.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }

  return 'sh';
}

const shCmd = findSh();

describe('docker-compose.staging.yml isolation and runtime invariants', () => {
  const content = readFileSync(STAGING_COMPOSE, 'utf8');

  it('manifest exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100);
  });

  it('is strictly runtime-only: no build directives exist', () => {
    expect(content).not.toMatch(/^\s*build:\s*$/m);
    expect(content).not.toMatch(/dockerfile:/i);
  });

  it('requires immutable image digest via TUGPT_WEB_STAGING_IMAGE with no mutable tag fallback', () => {
    expect(content).toMatch(/image:\s*"\$\{TUGPT_WEB_STAGING_IMAGE:\?.*digest.*required\}"/);
    expect(content).not.toMatch(/\$\{TUGPT_WEB_STAGING_IMAGE:-/);
  });

  it('binds strictly to loopback 127.0.0.1:3002:3000', () => {
    const uncommented = content.replace(/#.*$/gm, '');
    expect(uncommented).toMatch(/["']?127\.0\.0\.1:3002:3000["']?/);
    expect(uncommented).not.toMatch(/0\.0\.0\.0/);
    expect(uncommented).not.toMatch(/3001:3000/);
    expect(uncommented).not.toMatch(/8188/);
  });

  it('enforces hardened container security options', () => {
    expect(content).toMatch(/no-new-privileges:true/);
    expect(content).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
    expect(content).toMatch(/\/tmp:rw,noexec,nosuid,size=256m/);
  });

  it('enforces strict cgroup CPU, Memory, and PIDs limits', () => {
    expect(content).toMatch(/cpus:\s*["']?2\.0["']?/);
    expect(content).toMatch(/memory:\s*2048M/);
    expect(content).toMatch(/pids:\s*100/);
  });

  it('excludes production queue workers to prevent duplicate message consumption', () => {
    expect(content).not.toMatch(/^\s*whatsapp-worker:/m);
    expect(content).not.toMatch(/^\s*draft-worker:/m);
    expect(content).not.toMatch(/^\s*transcription-worker:/m);
  });

  it('allocates zero GPU devices under the GPU moratorium', () => {
    expect(content).not.toMatch(/capabilities:\s*\[.*gpu.*\]/i);
    expect(content).not.toMatch(/driver:\s*nvidia/i);
    expect(content).not.toMatch(/devices:\s*\n/i);
  });

  it('resolves compose structure via docker compose config --format json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'compose-config-test-'));
    const dummyEnv = path.join(dir, 'dummy.env');
    writeFileSync(
      dummyEnv,
      [
        'TUGPT_ENVIRONMENT=staging',
        `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
      ].join('\n')
    );

    try {
      // 1. Success case with approved image
      const res = spawnSync(
        'docker',
        ['compose', '-f', STAGING_COMPOSE, 'config', '--format', 'json'],
        {
          env: {
            ...process.env,
            TUGPT_WEB_STAGING_IMAGE: APPROVED_IMAGE,
            TUGPT_STAGING_ENV_FILE: dummyEnv,
          },
          encoding: 'utf8',
        }
      );

      if (res.status === 0) {
        const resolved = JSON.parse(res.stdout);
        // Assert exactly web service
        expect(Object.keys(resolved.services)).toEqual(['web']);
        const web = resolved.services.web;
        expect(web.image).toBe(APPROVED_IMAGE);
        // Assert port binding
        expect(web.ports).toEqual([
          expect.objectContaining({
            host_ip: '127.0.0.1',
            target: 3000,
            published: '3002',
            protocol: 'tcp',
          }),
        ]);
        // Assert cgroups
        expect(web.deploy?.resources?.limits?.cpus).toBe(2);
        expect(Number(web.deploy?.resources?.limits?.memory)).toBe(2048 * 1024 * 1024);
        expect(web.deploy?.resources?.limits?.pids).toBe(100);
        // Assert zero GPU reservations
        expect(web.deploy?.resources?.reservations?.devices).toBeUndefined();
        // Assert bridge network
        expect(resolved.networks?.tugpt_staging_net?.driver).toBe('bridge');
      }

      // 2. Failure case when TUGPT_WEB_STAGING_IMAGE is empty
      const failRes = spawnSync(
        'docker',
        ['compose', '-f', STAGING_COMPOSE, 'config', '--format', 'json'],
        {
          env: {
            ...process.env,
            TUGPT_WEB_STAGING_IMAGE: '',
            TUGPT_STAGING_ENV_FILE: dummyEnv,
          },
          encoding: 'utf8',
        }
      );
      expect(failRes.status).not.toBe(0);
      expect(failRes.stderr + failRes.stdout).toMatch(/TUGPT_WEB_STAGING_IMAGE.*required/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deploy/staging/check-staging-env.sh preflight checks', () => {
  function runPreflightWithFile(content: string, manifest?: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-env-'));
    const envFile = path.join(dir, 'staging.env');
    writeFileSync(envFile, content);

    try {
      const args = [PREFLIGHT_SCRIPT, envFile];
      if (manifest) args.push(manifest);

      return spawnSync(shCmd, args, {
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const validStagingContent = [
    'TUGPT_ENVIRONMENT=staging',
    `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
    `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
  ].join('\n');

  it('passes when given valid staging environment configuration', () => {
    const res = runPreflightWithFile(validStagingContent, RELEASE_MANIFEST);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Staging preflight passed: all isolation checks green.');
    expect(res.stdout).toContain("PASS: TUGPT_ENVIRONMENT is 'staging'");
    expect(res.stdout).toContain('PASS: TUGPT_WEB_STAGING_IMAGE matches approved digest');
  });

  it('fails when TUGPT_ENVIRONMENT is not staging', () => {
    const content = validStagingContent.replace('TUGPT_ENVIRONMENT=staging', 'TUGPT_ENVIRONMENT=production');
    const res = runPreflightWithFile(content, RELEASE_MANIFEST);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("FAIL: TUGPT_ENVIRONMENT must be 'staging'");
  });

  it('fails when Supabase URL or anon key is missing', () => {
    const content = [
      'TUGPT_ENVIRONMENT=staging',
      `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
    ].join('\n');
    const res = runPreflightWithFile(content, RELEASE_MANIFEST);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('FAIL: NEXT_PUBLIC_SUPABASE_URL is missing or empty');
    expect(res.stderr).toContain('FAIL: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty');
  });

  it('fails loudly when NEXT_PUBLIC_SUPABASE_URL targets production project ref', () => {
    const content = [
      'TUGPT_ENVIRONMENT=staging',
      `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
      'NEXT_PUBLIC_SUPABASE_URL=https://rbiumegrwtavmljxbknp.supabase.co',
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
    ].join('\n');
    const res = runPreflightWithFile(content, RELEASE_MANIFEST);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('targets production project ref (rbiumegrwtavmljxbknp)!');
  });

  it('fails loudly when NEXT_PUBLIC_SUPABASE_URL format is invalid or insecure', () => {
    const badUrls = [
      'http://staging.example.supabase.co',
      ['https://user:pass', 'staging.example.supabase.co'].join('@'),
      'https://malicious.attacker.com',
    ];

    for (const badUrl of badUrls) {
      const content = [
        'TUGPT_ENVIRONMENT=staging',
        `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
        `NEXT_PUBLIC_SUPABASE_URL=${badUrl}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
      ].join('\n');
      const res = runPreflightWithFile(content, RELEASE_MANIFEST);
      expect(res.status, `badUrl: ${badUrl}`).toBe(1);
    }
  }, 20000);

  it('fails loudly when runtime Supabase URL does not match image build-time URL', () => {
    const content = [
      'TUGPT_ENVIRONMENT=staging',
      `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
      'NEXT_PUBLIC_SUPABASE_URL=https://other-staging.example.supabase.co',
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
    ].join('\n');
    const res = runPreflightWithFile(content, RELEASE_MANIFEST);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('does not match build-time manifest URL');
  });

  it('fails loudly when any TUGPT_SECRET_KEY_* variable is present (even if empty)', () => {
    const withSecret = [
      validStagingContent,
      'TUGPT_SECRET_KEY_PLATFORM_V1=',
    ].join('\n');
    const res = runPreflightWithFile(withSecret, RELEASE_MANIFEST);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Prohibited key 'TUGPT_SECRET_KEY_PLATFORM_V1'");
  });

  it('fails when TUGPT_WEB_STAGING_IMAGE is missing, mutable tag, or unapproved digest', () => {
    // Missing
    const missing = [
      'TUGPT_ENVIRONMENT=staging',
      `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
    ].join('\n');
    expect(runPreflightWithFile(missing, RELEASE_MANIFEST).status).toBe(1);

    // Tag only
    const tagOnly = [
      'TUGPT_ENVIRONMENT=staging',
      'TUGPT_WEB_STAGING_IMAGE=tugpt-web:staging',
      `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
    ].join('\n');
    const tagRes = runPreflightWithFile(tagOnly, RELEASE_MANIFEST);
    expect(tagRes.status).toBe(1);
    expect(tagRes.stderr).toContain('uses a mutable tag instead of @sha256: digest');

    // Unapproved digest
    const unapproved = [
      'TUGPT_ENVIRONMENT=staging',
      'TUGPT_WEB_STAGING_IMAGE=tugpt-web@sha256:1111111111111111111111111111111111111111111111111111111111111111',
      `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
    ].join('\n');
    const unapprovedRes = runPreflightWithFile(unapproved, RELEASE_MANIFEST);
    expect(unapprovedRes.status).toBe(1);
    expect(unapprovedRes.stderr).toContain('does not match administrator-approved digest');
  }, 20000);

  it('rejects duplicate keys and command injection in env file', () => {
    const duplicate = [
      validStagingContent,
      'TUGPT_ENVIRONMENT=staging',
    ].join('\n');
    const dupRes = runPreflightWithFile(duplicate, RELEASE_MANIFEST);
    expect(dupRes.status).toBe(1);
    expect(dupRes.stderr).toContain("Duplicate key 'TUGPT_ENVIRONMENT'");

    const injection = [
      validStagingContent,
      'INJECTION=$(touch /tmp/pwned)',
    ].join('\n');
    const injRes = runPreflightWithFile(injection, RELEASE_MANIFEST);
    expect(injRes.status).toBe(1);
    expect(injRes.stderr).toContain('command substitution syntax');
  });

  it('fails with exit code 2 if the specified env file does not exist', () => {
    const nonExistent = path.join(tmpdir(), 'non-existent-staging-env.env');
    const res = spawnSync(shCmd, [PREFLIGHT_SCRIPT, nonExistent], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('is not readable or does not exist');
  });
});

describe('deploy/staging/launch-staging.sh administrator launcher acceptance', () => {
  it('aborts with exit code 2 if bundle directory does not exist', () => {
    const nonExistent = path.join(tmpdir(), 'non-existent-bundle-dir');
    const res = spawnSync(shCmd, [LAUNCHER_SCRIPT, nonExistent], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('does not exist');
  });

  it('aborts with exit code 2 if environment file does not exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'launcher-missing-env-'));
    try {
      const nonExistentEnv = path.join(dir, 'missing.env');
      const res = spawnSync(shCmd, [LAUNCHER_SCRIPT, dir, nonExistentEnv], {
        env: {
          ...process.env,
          STAGING_SKIP_PERM_CHECK: '1',
        },
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts before executing Docker Compose if preflight validation fails', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'launcher-fail-preflight-'));
    try {
      const envFile = path.join(dir, 'staging.env');
      // Invalid env (tag-only image)
      writeFileSync(
        envFile,
        [
          'TUGPT_ENVIRONMENT=staging',
          'TUGPT_WEB_STAGING_IMAGE=tugpt-web:staging',
          `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
        ].join('\n')
      );

      const res = spawnSync(shCmd, [LAUNCHER_SCRIPT, dir, envFile], {
        env: {
          ...process.env,
          STAGING_SKIP_PERM_CHECK: '1',
          DOCKER_COMPOSE_CMD: 'echo COMPOSE_SHOULD_NOT_BE_CALLED',
        },
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain('FATAL: Staging preflight validation failed! Container launch aborted.');
      expect(res.stdout).not.toContain('COMPOSE_SHOULD_NOT_BE_CALLED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects command substitution in env file without executing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'launcher-injection-'));
    const marker = path.join(dir, 'marker.txt');
    try {
      const envFile = path.join(dir, 'staging.env');
      writeFileSync(
        envFile,
        [
          'TUGPT_ENVIRONMENT=staging',
          `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
          `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
          `MALICIOUS=$(touch "${marker}")`,
        ].join('\n')
      );

      const res = spawnSync(shCmd, [LAUNCHER_SCRIPT, dir, envFile], {
        env: {
          ...process.env,
          STAGING_SKIP_PERM_CHECK: '1',
          DOCKER_COMPOSE_CMD: 'echo COMPOSE_SHOULD_NOT_BE_CALLED',
        },
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });

      expect(res.status).toBe(1);
      expect(existsSync(marker), 'command substitution must never be executed').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launches Docker Compose with up -d when preflight passes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'launcher-success-'));
    try {
      const envFile = path.join(dir, 'staging.env');
      writeFileSync(
        envFile,
        [
          'TUGPT_ENVIRONMENT=staging',
          `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
          `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
        ].join('\n')
      );

      const res = spawnSync(shCmd, [LAUNCHER_SCRIPT, dir, envFile], {
        env: {
          ...process.env,
          STAGING_SKIP_PERM_CHECK: '1',
          DOCKER_COMPOSE_CMD: 'echo STUB_COMPOSE',
        },
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain('STUB_COMPOSE -p tugpt-staging -f');
      expect(res.stdout).toContain('up -d');
      expect(res.stdout).toContain('Staging launch complete. Bound to 127.0.0.1:3002.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});