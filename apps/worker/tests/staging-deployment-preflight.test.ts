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
 *    - Mandatory administrator release manifest with JSON schema v1.0.0 validation.
 *    - Target environment must be staging.
 *    - Strict web-only environment key allowlist (unknown and privileged keys rejected).
 *    - All TUGPT_SECRET_KEY_* variables strictly rejected (in file and ambient environment).
 *    - Positive Supabase HTTPS URL validation (no userinfo, port, path, query; rejects production ref).
 *    - Runtime URL and Anon Key must match build-time manifest settings.
 *    - Rejection of shell command substitution, variable interpolation, and duplicate keys.
 * 7. Privileged Launcher invariants:
 *    - Effective root UID (0) enforcement.
 *    - Exact ownership (root:root) and modes (0700 dir/scripts, 0600 env/manifest/compose).
 *    - Trusted parent directories (/etc and /etc/tugpt).
 *    - Strict rejection of symlinks on all bundle components.
 *    - Mandatory preflight abort before Docker is touched.
 *    - Minimal execution environment (env -i).
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
const FIXTURES_DIR = path.join(REPO_ROOT, 'apps', 'worker', 'tests', 'fixtures', 'manifests');
const VALID_MANIFEST = path.join(FIXTURES_DIR, 'valid-manifest.json');

const APPROVED_REPO = 'ghcr.io/coderxp1/tugpt-web';
const APPROVED_DIGEST = 'sha256:0ad074799abb27b96cc85c3e31ac50f9ee417595fff2e29088a3a093e634e54e';
const APPROVED_IMAGE = `${APPROVED_REPO}@${APPROVED_DIGEST}`;
const APPROVED_URL = 'https://test-fixture-staging.supabase.co';
const APPROVED_ANON_KEY = 'test-fixture-anon-key-token';

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

describe('docker-compose.staging.yml isolation and runtime invariants', { timeout: 30000 }, () => {
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

      expect(res.status, `docker compose config failed: ${res.stderr}`).toBe(0);
      const resolved = JSON.parse(res.stdout);

      // Assert exactly web service
      expect(Object.keys(resolved.services)).toEqual(['web']);
      const web = resolved.services.web;
      expect(web.image).toBe(APPROVED_IMAGE);

      // Assert port binding strictly 127.0.0.1:3002:3000
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

describe('check-staging-env.sh preflight validation and schema enforcement', { timeout: 30000 }, () => {
  const validStagingContent = [
    'TUGPT_ENVIRONMENT=staging',
    `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
    `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
  ].join('\n');

  function runPreflightWithFile(
    envContent: string,
    manifestPath: string,
    extraEnv: Record<string, string> = {}
  ): { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-test-'));
    const envFile = path.join(dir, 'staging.env');
    writeFileSync(envFile, envContent);

    try {
      const res = spawnSync(shCmd, [PREFLIGHT_SCRIPT, envFile, manifestPath], {
        env: {
          ...process.env,
          ...extraEnv,
        },
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });

      return {
        status: res.status ?? 1,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes cleanly on valid staging environment matching approved release manifest', () => {
    const res = runPreflightWithFile(validStagingContent, VALID_MANIFEST);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Preflight validation PASSED');
  });

  describe('Manifest schema and fail-closed validation', () => {
    it('fails closed with exit code 2 when manifest path is missing or non-existent', () => {
      const res = runPreflightWithFile(validStagingContent, path.join(tmpdir(), 'non-existent-manifest.json'));
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('is not readable or does not exist');
    });

    it('fails closed when manifest is malformed JSON', () => {
      const res = runPreflightWithFile(validStagingContent, path.join(FIXTURES_DIR, 'malformed.json'));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Release manifest is not valid JSON');
    });

    it('fails closed when manifest is missing required approval fields', () => {
      const res = runPreflightWithFile(validStagingContent, path.join(FIXTURES_DIR, 'missing-fields.json'));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Manifest schema validation errors');
    });

    it('fails closed when manifest contains short digest', () => {
      const res = runPreflightWithFile(validStagingContent, path.join(FIXTURES_DIR, 'bad-digest-short.json'));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('approvedDigest must be sha256:<64 lowercase hex characters>');
    });

    it('fails closed when manifest contains non-hex characters in digest', () => {
      const res = runPreflightWithFile(validStagingContent, path.join(FIXTURES_DIR, 'bad-digest-nonhex.json'));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('approvedDigest must be sha256:<64 lowercase hex characters>');
    });

    it('fails closed when manifest specifies non-staging targetEnvironment', () => {
      const res = runPreflightWithFile(validStagingContent, path.join(FIXTURES_DIR, 'wrong-environment.json'));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('targetEnvironment must be staging');
    });
  });

  describe('Environment key allowlist and secret protections', () => {
    it('fails loudly when an unknown or unauthorized key is present in staging configuration', () => {
      const withUnknown = [
        validStagingContent,
        'UNKNOWN_CUSTOM_SETTING=dangerous_value',
      ].join('\n');
      const res = runPreflightWithFile(withUnknown, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Unknown or unauthorized key 'UNKNOWN_CUSTOM_SETTING'");
    });

    it('fails loudly when any TUGPT_SECRET_KEY_* is present in env file (even if empty)', () => {
      const withSecret = [
        validStagingContent,
        'TUGPT_SECRET_KEY_PLATFORM_V1=',
      ].join('\n');
      const res = runPreflightWithFile(withSecret, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Prohibited platform master secret key 'TUGPT_SECRET_KEY_PLATFORM_V1'");
    });

    it('fails loudly when ambient process environment contains TUGPT_SECRET_KEY_*', () => {
      const res = runPreflightWithFile(validStagingContent, VALID_MANIFEST, {
        TUGPT_SECRET_KEY_AMBIENT_PROBE: 'should-abort',
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Prohibited platform master secret 'TUGPT_SECRET_KEY_AMBIENT_PROBE'");
    });

    it('fails loudly when variable interpolation ($VAR or ${VAR}) is detected', () => {
      const withInterpolation = [
        validStagingContent,
        'PORT=$SOME_VAR',
      ].join('\n');
      const res = runPreflightWithFile(withInterpolation, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Forbidden shell variable interpolation');
    });

    it('fails loudly when command substitution or injection syntax is detected', () => {
      const withSubst = [
        validStagingContent,
        'PORT=$(id -u)',
      ].join('\n');
      const res = runPreflightWithFile(withSubst, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Forbidden shell command substitution');
    });

    it('fails loudly on duplicate keys', () => {
      const duplicate = [
        validStagingContent,
        'TUGPT_ENVIRONMENT=staging',
      ].join('\n');
      const res = runPreflightWithFile(duplicate, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Duplicate key 'TUGPT_ENVIRONMENT'");
    });
  });

  describe('Staging identity & build-time binding', () => {
    it('fails loudly when TUGPT_ENVIRONMENT is not staging', () => {
      const wrongEnv = [
        'TUGPT_ENVIRONMENT=production',
        `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
        `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
      ].join('\n');
      const res = runPreflightWithFile(wrongEnv, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("TUGPT_ENVIRONMENT must be 'staging'");
    });

    it('fails loudly when NEXT_PUBLIC_SUPABASE_URL format is invalid or insecure', () => {
      const badUrls = [
        'http://test-fixture-staging.supabase.co',
        ['https://user:pass', 'test-fixture-staging.supabase.co'].join('@'),
        'https://malicious.attacker.com',
      ];

      for (const badUrl of badUrls) {
        const content = [
          'TUGPT_ENVIRONMENT=staging',
          `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
          `NEXT_PUBLIC_SUPABASE_URL=${badUrl}`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
        ].join('\n');
        const res = runPreflightWithFile(content, VALID_MANIFEST);
        expect(res.status, `badUrl: ${badUrl}`).toBe(1);
      }
    });

    it('fails loudly when NEXT_PUBLIC_SUPABASE_URL targets production project ref', () => {
      const prodRefUrl = 'https://rbiumegrwtavmljxbknp.supabase.co';
      const content = [
        'TUGPT_ENVIRONMENT=staging',
        `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
        `NEXT_PUBLIC_SUPABASE_URL=${prodRefUrl}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
      ].join('\n');
      const res = runPreflightWithFile(content, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('targets production project ref (rbiumegrwtavmljxbknp)');
    });

    it('fails loudly when runtime Supabase URL does not match image build-time URL', () => {
      const content = [
        'TUGPT_ENVIRONMENT=staging',
        `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
        'NEXT_PUBLIC_SUPABASE_URL=https://other-staging.supabase.co',
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
      ].join('\n');
      const res = runPreflightWithFile(content, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('does not match build-time manifest URL');
    });

    it('fails loudly when runtime anon key does not match build-time anonymous key', () => {
      const content = [
        'TUGPT_ENVIRONMENT=staging',
        `TUGPT_WEB_STAGING_IMAGE=${APPROVED_IMAGE}`,
        `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
        'NEXT_PUBLIC_SUPABASE_ANON_KEY=mismatched-anon-token',
      ].join('\n');
      const res = runPreflightWithFile(content, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('does not match build-time manifest anonymous key');
    });

    it('fails loudly when image reference uses mutable tag or wrong digest', () => {
      const tagContent = [
        'TUGPT_ENVIRONMENT=staging',
        `TUGPT_WEB_STAGING_IMAGE=${APPROVED_REPO}:latest`,
        `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_URL}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${APPROVED_ANON_KEY}`,
      ].join('\n');
      const res = runPreflightWithFile(tagContent, VALID_MANIFEST);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('uses a mutable tag instead of @sha256: digest');
    });
  });
});

describe('launch-staging.sh privileged launcher security boundaries', { timeout: 45000 }, () => {
  it('strictly rejects execution if effective UID is not root (0)', () => {
    // When run directly by non-root developer/runner process:
    const res = spawnSync(shCmd, [LAUNCHER_SCRIPT], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });

    // If current runner process is not root, it must exit 2 with clear error
    if (process.getuid ? process.getuid() !== 0 : true) {
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('must be executed as root (effective UID 0)');
    }
  });

  it('verifies launcher permission and symlink checks in disposable Linux container', () => {
    const dockerCheck = spawnSync('docker', ['info'], { encoding: 'utf8' });
    if (dockerCheck.status !== 0) {
      // Docker daemon not active locally; skip container-in-docker test
      return;
    }

    // Run tests inside an isolated alpine container where UID 0 is standard
    // Test: symlink detection on bundle dir

    const symlinkTest = spawnSync('docker', [
      'run', '--rm',
      '-v', `${REPO_ROOT}:/repo:ro`,
      'alpine:latest',
      'sh', '-c',
      'mkdir -p /etc/tugpt && ln -s /tmp /etc/tugpt/staging && sh /repo/deploy/staging/launch-staging.sh; exit $?',
    ], { encoding: 'utf8' });

    expect(symlinkTest.status).toBe(2);
    expect(symlinkTest.stderr).toContain('Symlink detected');



    // Test: insecure permissions (0777) on bundle directory
    const permsTest = spawnSync('docker', [
      'run', '--rm',
      '-v', `${REPO_ROOT}:/repo:ro`,
      'alpine:latest',
      'sh', '-c',
      'mkdir -p /etc/tugpt/staging && chmod 777 /etc/tugpt/staging && sh /repo/deploy/staging/launch-staging.sh; exit $?',
    ], { encoding: 'utf8' });

    expect(permsTest.status).toBe(2);

  }, 30000);
});