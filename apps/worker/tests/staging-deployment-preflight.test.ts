/**
 * @file staging-deployment-preflight.test.ts
 * @description Validates the runtime-only staging manifest and staging environment preflight checks.
 *
 * GOVERNANCE AND INVARIANTS (ADR-018):
 * 1. Runtime-only: docker-compose.staging.yml must NOT contain build blocks.
 * 2. Host isolation: Staging web binds strictly to 127.0.0.1:3002 (never 0.0.0.0, avoiding 3001 and 8188).
 * 3. Queue protection: Production queue workers are strictly EXCLUDED from staging.
 * 4. Zero GPU devices: GPU moratorium active, no devices reserved.
 * 5. Environment preflight:
 *    - TUGPT_ENVIRONMENT must be staging.
 *    - Supabase URL must never match production project ref rbiumegrwtavmljxbknp.
 *    - TUGPT_SECRET_KEY_PLATFORM_V1 must never be set in staging.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STAGING_COMPOSE = path.join(REPO_ROOT, 'docker-compose.staging.yml');
const PREFLIGHT_SCRIPT = path.join(REPO_ROOT, 'deploy', 'staging', 'check-staging-env.sh');

/** Locate a working POSIX sh executable across Linux/macOS and Windows environments. */
function findSh(): string {
  // Direct PATH check
  const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['sh']);
  if (which.status === 0 && which.stdout.toString().trim()) {
    return which.stdout.toString().trim().split('\n')[0].trim();
  }

  // Common Git on Windows paths
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

describe('docker-compose.staging.yml isolation and runtime invariants', () => {
  const content = readFileSync(STAGING_COMPOSE, 'utf8');

  it('manifest exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100);
  });

  it('is strictly runtime-only: no build directives exist', () => {
    // Assert no `build:` key appears in the service definitions
    expect(content).not.toMatch(/^\s*build:\s*$/m);
    expect(content).not.toMatch(/dockerfile:/i);
  });

  it('references image via TUGPT_WEB_STAGING_IMAGE with fallback to tugpt-web:staging', () => {
    expect(content).toMatch(/image:\s*\$\{TUGPT_WEB_STAGING_IMAGE:-tugpt-web:staging\}/);
  });

  it('binds strictly to loopback 127.0.0.1:3002:3000', () => {
    const uncommented = content.replace(/#.*$/gm, '');
    // Must bind to 127.0.0.1:3002:3000
    expect(uncommented).toMatch(/["']?127\.0\.0\.1:3002:3000["']?/);
    // Must not bind to 0.0.0.0 in active configuration
    expect(uncommented).not.toMatch(/0\.0\.0\.0/);
    // Must not bind to port 3001 (production) or 8188 (ComfyUI)
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
});

describe('deploy/staging/check-staging-env.sh preflight checks', () => {
  const shCmd = findSh();

  function runScript(env: Record<string, string>, arg?: string) {
    const passedEnv = {
      ...process.env,
      ...env,
    };
    const args = [PREFLIGHT_SCRIPT];
    if (arg) args.push(arg);

    return spawnSync(shCmd, args, {
      env: passedEnv,
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
  }

  it('passes when given valid staging environment variables', () => {
    const res = runScript({
      TUGPT_ENVIRONMENT: 'staging',
      NEXT_PUBLIC_SUPABASE_URL: 'https://staging-project-123.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'staging-anon-key-abc',
      TUGPT_SECRET_KEY_PLATFORM_V1: '',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Staging preflight passed: all isolation checks green.');
    expect(res.stdout).toContain("PASS: TUGPT_ENVIRONMENT is 'staging'");
  });

  it('fails when TUGPT_ENVIRONMENT is not staging', () => {
    const res = runScript({
      TUGPT_ENVIRONMENT: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://staging-project-123.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'staging-anon-key-abc',
      TUGPT_SECRET_KEY_PLATFORM_V1: '',
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("FAIL: TUGPT_ENVIRONMENT must be 'staging'");
  });

  it('fails when Supabase URL or anon key is missing', () => {
    const res = runScript({
      TUGPT_ENVIRONMENT: 'staging',
      NEXT_PUBLIC_SUPABASE_URL: '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
      TUGPT_SECRET_KEY_PLATFORM_V1: '',
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('FAIL: NEXT_PUBLIC_SUPABASE_URL is missing or empty');
    expect(res.stderr).toContain('FAIL: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty');
  });

  it('fails loudly when NEXT_PUBLIC_SUPABASE_URL targets production project ref', () => {
    const res = runScript({
      TUGPT_ENVIRONMENT: 'staging',
      NEXT_PUBLIC_SUPABASE_URL: 'https://rbiumegrwtavmljxbknp.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'staging-anon-key-abc',
      TUGPT_SECRET_KEY_PLATFORM_V1: '',
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('targets production project ref (rbiumegrwtavmljxbknp)!');
  });

  it('fails loudly when production master secret key TUGPT_SECRET_KEY_PLATFORM_V1 is present', () => {
    const res = runScript({
      TUGPT_ENVIRONMENT: 'staging',
      NEXT_PUBLIC_SUPABASE_URL: 'https://staging-project-123.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'staging-anon-key-abc',
      TUGPT_SECRET_KEY_PLATFORM_V1: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('TUGPT_SECRET_KEY_PLATFORM_V1 is present! Production master platform keys are forbidden in staging.');
  });

  it('correctly sources and validates an env file passed as argument', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'staging-env-test-'));
    const envFile = path.join(dir, 'test.env');

    try {
      writeFileSync(
        envFile,
        [
          'TUGPT_ENVIRONMENT=staging',
          'NEXT_PUBLIC_SUPABASE_URL=https://staging-envfile-test.supabase.co',
          'NEXT_PUBLIC_SUPABASE_ANON_KEY=test-anon-key-xyz',
          '',
        ].join('\n')
      );

      const res = runScript({ TUGPT_SECRET_KEY_PLATFORM_V1: '' }, envFile);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Staging preflight passed: all isolation checks green.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with exit code 2 if the specified env file does not exist', () => {
    const nonExistent = path.join(tmpdir(), 'non-existent-staging-env.env');
    const res = runScript({}, nonExistent);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('is not readable or does not exist');
  });
});