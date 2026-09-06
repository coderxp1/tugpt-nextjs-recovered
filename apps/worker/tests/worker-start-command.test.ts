/**
 * The worker containers must not be started with `node dist/...` until the
 * @tugpt/* packages they import actually build.
 *
 * On 2026-08-25, the first-ever boot of the worker images crash-looped:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *   '/app/packages/database/src/client'
 *   imported from /app/packages/database/src/index.ts
 *
 * The chain: every @tugpt/* package sets `"main": "./src/index.ts"` and none
 * defines a build script, so no `dist/` is ever produced for them. The worker's
 * own `tsc` compiles only `apps/worker/src`, and its output still resolves
 * `@tugpt/database` to raw TypeScript. Node 22 can type-strip `.ts`, but ESM
 * requires explicit import extensions, and those packages write `./client`
 * rather than `./client.js` — so the process dies before it reaches main().
 *
 * It stayed hidden for months because every earlier execution path — `pnpm dev`,
 * the e2e harness, the old native systemd units — ran under `tsx`, which
 * resolves extensionless imports. The container start path was the one path
 * nothing exercised.
 *
 * So this file does not pin "the command is tsx". It pins the *precondition*:
 *
 *   `node dist/...` is permitted only once every @tugpt/* package the worker
 *   depends on has a build script.
 *
 * Written that way, the guard needs no edit when the packages are fixed. It
 * simply stops objecting — and until then it fails anyone who reverts the
 * command without doing the work first.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPOSE = path.join(REPO_ROOT, 'docker-compose.yml');
const DOCKERFILE = path.join(REPO_ROOT, 'apps', 'worker', 'Dockerfile');
const WORKER_PKG = path.join(REPO_ROOT, 'apps', 'worker', 'package.json');

type Runner = 'tsx' | 'node-dist';

function classifyRunner(command: string): Runner | 'unknown' {
  if (command.includes('tsx')) return 'tsx';
  if (/\bnode\b/.test(command) && command.includes('dist/')) return 'node-dist';
  return 'unknown';
}

/** The `command:` line for a named service in docker-compose.yml. */
function composeCommand(service: string): string {
  const yaml = readFileSync(COMPOSE, 'utf8');
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${service}:`);
  expect(start, `service ${service} not found in docker-compose.yml`).toBeGreaterThan(-1);

  for (let i = start + 1; i < lines.length; i++) {
    // Stop at the next service (two-space indent, ends with a colon).
    if (/^ {2}\S.*:\s*$/.test(lines[i])) break;
    const match = lines[i].match(/^\s*command:\s*(.+)$/);
    if (match) return match[1].trim();
  }
  throw new Error(`no command: found for service ${service}`);
}

/** The final CMD in the worker Dockerfile. */
function dockerfileCmd(): string {
  const lines = readFileSync(DOCKERFILE, 'utf8').split('\n');
  const cmds = lines.filter((l) => l.startsWith('CMD '));
  expect(cmds.length, 'expected exactly one CMD in the worker Dockerfile').toBe(1);
  return cmds[0];
}

/** Map @tugpt/<name> -> package directory, read from the packages themselves. */
function workspacePackages(): Map<string, string> {
  const dir = path.join(REPO_ROOT, 'packages');
  const map = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const pkgPath = path.join(dir, entry, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name) map.set(pkg.name, path.join(dir, entry));
    } catch {
      // Not a package directory.
    }
  }
  return map;
}

/** The @tugpt/* packages apps/worker depends on at runtime. */
function workerTugptDeps(): string[] {
  const pkg = JSON.parse(readFileSync(WORKER_PKG, 'utf8'));
  return Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@tugpt/'));
}

function packagesMissingABuild(): string[] {
  const all = workspacePackages();
  const missing: string[] = [];
  for (const dep of workerTugptDeps()) {
    const dir = all.get(dep);
    expect(dir, `${dep} is a worker dependency but no package under packages/ declares that name`).toBeDefined();
    const pkg = JSON.parse(readFileSync(path.join(dir as string, 'package.json'), 'utf8'));
    if (!pkg.scripts?.build) missing.push(dep);
  }
  return missing;
}

const SERVICES = ['whatsapp-worker', 'draft-worker', 'transcription-worker'] as const;

describe('worker container start command', () => {
  it('finds the files it is guarding (a moved file must fail loudly, not silently pass)', () => {
    expect(() => readFileSync(COMPOSE, 'utf8')).not.toThrow();
    expect(() => readFileSync(DOCKERFILE, 'utf8')).not.toThrow();
    expect(workerTugptDeps().length).toBeGreaterThan(0);
  });

  it.each(SERVICES)('%s starts with a runner this repo can actually run', (service) => {
    const command = composeCommand(service);
    const runner = classifyRunner(command);
    expect(runner, `${service} command not recognised as tsx or node dist/: ${command}`).not.toBe(
      'unknown'
    );

    const missing = packagesMissingABuild();
    if (missing.length > 0) {
      expect(
        runner,
        `${service} runs \`${command}\`, but ${missing.join(', ')} ${
          missing.length === 1 ? 'has' : 'have'
        } no build script, so no dist/ exists for ${
          missing.length === 1 ? 'it' : 'them'
        } and the compiled worker resolves ${
          missing.length === 1 ? 'it' : 'them'
        } to raw TypeScript with extensionless ESM imports. This is the 2026-08-25 crash-loop. ` +
          `Either keep the tsx command, or give those packages a real build first.`
      ).toBe('tsx');
    }
  });

  it('keeps the Dockerfile CMD on the same runner as compose', () => {
    const cmd = dockerfileCmd();
    const cmdRunner = classifyRunner(cmd);
    const composeRunners = SERVICES.map((s) => classifyRunner(composeCommand(s)));

    // A bare `docker run` of this image uses CMD. If compose is on tsx because
    // dist/ does not work, CMD pointing at dist/ is broken in exactly the way
    // compose was hiding before 2026-08-25.
    for (const runner of composeRunners) {
      expect(cmdRunner, `Dockerfile CMD (${cmd}) disagrees with the compose commands`).toBe(runner);
    }
  });

  it('does not install production-only dependencies while running under tsx', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    const runsTsx = SERVICES.some((s) => classifyRunner(composeCommand(s)) === 'tsx');
    if (!runsTsx) return;

    const workerPkg = JSON.parse(readFileSync(WORKER_PKG, 'utf8'));
    expect(
      workerPkg.devDependencies?.tsx,
      'tsx is expected to be a devDependency of @tugpt/worker; if it moved, revisit this test'
    ).toBeDefined();

    // tsx lives in devDependencies, so a production-only install removes the
    // very thing the container is started with.
    const prodInstall = /pnpm install[^\n]*(--prod\b|--production\b)/.test(dockerfile);
    expect(
      prodInstall,
      'the worker image installs production-only dependencies, but the container is started with tsx, ' +
        'which is a devDependency of @tugpt/worker. That combination cannot boot.'
    ).toBe(false);
  });

  it('points at entrypoints that exist', () => {
    for (const service of SERVICES) {
      const command = composeCommand(service);
      const entry = command.match(/src\/[A-Za-z0-9_.-]+\.ts|dist\/[A-Za-z0-9_.-]+\.js/)?.[0];
      expect(entry, `no entrypoint found in ${service} command: ${command}`).toBeDefined();
      if ((entry as string).startsWith('src/')) {
        const abs = path.join(REPO_ROOT, 'apps', 'worker', entry as string);
        expect(() => readFileSync(abs, 'utf8'), `${service} entrypoint ${entry} does not exist`).not.toThrow();
      }
    }
  });
});
