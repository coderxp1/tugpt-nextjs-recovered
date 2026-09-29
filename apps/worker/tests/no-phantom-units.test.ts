/**
 * No runbook may tell an operator to drive a systemd unit this host does not
 * have.
 *
 * WHY THIS EXISTS
 *
 * Until 2026-08-24 the workers ran as systemd-native units,
 * `tugpt-whatsapp-worker` and `tugpt-draft-worker`. The host was compromised
 * and reinstalled, and neither unit came back: `deploy/systemd/` contains
 * `tugpt.service` and `tugpt-web.service` and nothing else, and
 * `docs/production_environment.md` §5.1 says so plainly. The workers are
 * containers under one unit.
 *
 * The runbooks did not follow. Fifteen instructions across
 * `docs/controlled-rollout.md`, `docs/milestone1-e2e-runbook.md`,
 * `docs/server-migrations.md` and the milestone-1 harness's own failure
 * messages still drove the units that no longer exist — every one of them on
 * the critical path of enabling draft generation.
 *
 * THE FAILURE MODE IS THE DANGEROUS ONE
 *
 * `systemctl is-active tugpt-draft-worker` on a host without that unit prints
 * `inactive` and exits non-zero. An operator running the pre-flight checklist
 * reads that as "the workers are down" while they are up, and either aborts a
 * correct rollout or goes looking for a problem that is not there.
 *
 * `journalctl -u tugpt-draft-worker` is worse, because it fails silently. It
 * prints nothing — not an error, nothing — so the rollout's watch step, the one
 * that is supposed to run for a full business day and catch trouble, returns a
 * clean empty result no matter what the worker is doing. That is a false green,
 * and it is the same shape as the one that got past us on 2026-08-26: a command
 * that cannot produce the output it is being checked for.
 *
 * WHAT IS GUARDED
 *
 * Commands, not prose. In Markdown only fenced code blocks are inspected, so a
 * document can still explain that `journalctl -u tugpt-draft-worker` is the
 * wrong thing to run — which `controlled-rollout.md` §5 now does. Shell scripts
 * are inspected in full.
 *
 * Source files are inspected in full: a unit name inside a string literal is an
 * instruction the moment it is printed to an operator, which is exactly how the
 * milestone-1 harness's two timeout messages went stale. They pointed at
 * `systemctl status tugpt-draft-worker` — printed at the precise moment someone
 * is working out why the harness produced no draft.
 *
 * The set of real units is read from `deploy/systemd/` rather than hardcoded,
 * so adding a unit file is all it takes to make its name legal here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SELF = 'apps/worker/tests/no-phantom-units.test.ts';

/** Units that actually exist, read from the unit files themselves. */
function realUnits(): Set<string> {
  const dir = path.join(REPO_ROOT, 'deploy', 'systemd');
  const units = readdirSync(dir)
    .filter((f) => f.endsWith('.service'))
    .map((f) => f.replace(/\.service$/, ''));
  return new Set(units);
}

/**
 * A line is an invocation if it runs systemctl or journalctl; the units it acts
 * on are every `tugpt-*` token on it.
 *
 * Deliberately not a command-line parser. `systemctl is-active A B` acts on two
 * units, `deploy/check-host.sh` calls it through `$SYSTEMCTL_CMD`, and the flags
 * differ everywhere — a parser modelling all of that is a second thing to keep
 * correct, and the first version of it silently matched one unit out of two.
 * Line-scoped matching has no such failure mode: over-matching costs an
 * allowlist entry with a reason, which is the outcome we want anyway.
 *
 * `tugpt` and `tugpt.service` do not match — the token requires a hyphen — and
 * both are real units regardless. A trailing `.service` falls outside the
 * character class, so `tugpt-draft-worker.service` yields `tugpt-draft-worker`.
 */
const RUNNER = /systemctl|journalctl/i;
const UNIT_TOKEN = /\btugpt-[a-z0-9-]+/g;

/** The units a line acts on, or [] if it is not an invocation. */
export function unitsOnLine(text: string): string[] {
  if (!RUNNER.test(text)) return [];
  return [...text.matchAll(UNIT_TOKEN)].map((m) => m[0]);
}

/**
 * Files that may name a unit that does not exist, and why.
 */
const ALLOWED = new Map<string, string>([
  [
    'deploy/check-host.sh',
    'The `units` check asserts these units are NOT enabled — two consumers on one ' +
      'PGMQ queue double-process every message (docker-compose.yml, STANDING RULE). ' +
      'It is the one place naming them is the point: `is-enabled` returning ' +
      'anything but a failure is what the check reports.',
  ],
]);

const SEARCH_ROOTS = [
  { dir: 'docs', exts: ['.md'], fencedOnly: true },
  { dir: 'deploy', exts: ['.sh'], fencedOnly: false },
  { dir: 'apps', exts: ['.ts', '.tsx'], fencedOnly: false },
  { dir: 'packages', exts: ['.ts', '.tsx'], fencedOnly: false },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', '.git', 'coverage']);

function walk(dir: string, exts: string[], out: string[]): void {
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
    if (isDir) walk(full, exts, out);
    else if (exts.some((e) => full.endsWith(e))) out.push(path.relative(REPO_ROOT, full));
  }
}

/**
 * Lines that count as instructions. For Markdown that means fenced code blocks
 * only — prose describing a command is documentation, not an instruction.
 */
export function instructionLines(content: string, fencedOnly: boolean): { line: number; text: string }[] {
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

function offenders(): string[] {
  const units = realUnits();
  const found: string[] = [];

  for (const root of SEARCH_ROOTS) {
    const files: string[] = [];
    walk(path.join(REPO_ROOT, root.dir), root.exts, files);

    for (const rel of files) {
      if (rel === SELF || ALLOWED.has(rel)) continue;
      let content: string;
      try {
        content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      for (const { line, text } of instructionLines(content, root.fencedOnly)) {
        for (const unit of unitsOnLine(text)) {
          if (!units.has(unit)) found.push(`${rel}:${line}  ${unit}  — ${text.trim()}`);
        }
      }
    }
  }
  return found;
}

describe('no runbook drives a unit this host does not have', () => {
  it('reads the real unit set from deploy/systemd (an empty set would pass everything)', () => {
    const units = realUnits();
    expect(units.size, 'no .service files found — check deploy/systemd/').toBeGreaterThan(0);
    expect(units.has('tugpt'), 'tugpt.service is the unit that owns the stack').toBe(true);
  });

  it('matches the invocations that go stale, and not the prose that explains them', () => {
    // Positive controls — every shape that was actually in the runbooks.
    // The first one is why this is line-scoped: it acts on two units, and a
    // verb-parsing version of this pattern returned only the second.
    expect(unitsOnLine('systemctl is-active tugpt-draft-worker tugpt-whatsapp-worker')).toEqual([
      'tugpt-draft-worker',
      'tugpt-whatsapp-worker',
    ]);
    expect(unitsOnLine('sudo systemctl restart tugpt-draft-worker')).toEqual(['tugpt-draft-worker']);
    expect(unitsOnLine('systemctl status tugpt-whatsapp-worker')).toEqual(['tugpt-whatsapp-worker']);
    expect(unitsOnLine("journalctl -u tugpt-draft-worker --since '1 hour ago'")).toEqual([
      'tugpt-draft-worker',
    ]);
    // check-host.sh calls it indirectly, and with the long spelling.
    expect(unitsOnLine('$SYSTEMCTL_CMD is-enabled tugpt-whatsapp-worker.service')).toEqual([
      'tugpt-whatsapp-worker',
    ]);

    // Must still match when the unit is real — the *file set* decides legality,
    // not the pattern. Otherwise renaming a unit would silently pass.
    expect(unitsOnLine('systemctl restart tugpt-web')).toEqual(['tugpt-web']);

    // The unit that owns the stack is not a `tugpt-*` token and needs no exemption.
    expect(unitsOnLine('systemctl restart tugpt.service')).toEqual([]);

    // Must NOT match: a mention with no command on the line.
    expect(unitsOnLine('there is no tugpt-draft-worker unit on this host')).toEqual([]);
    expect(unitsOnLine('`tugpt-whatsapp-worker.service` was disabled during cutover')).toEqual([]);
  });

  it('reads Markdown commands but not Markdown prose', () => {
    const doc = [
      'Do not run `journalctl -u tugpt-draft-worker` — it prints nothing.',
      '',
      '```bash',
      'systemctl is-active tugpt-draft-worker',
      '```',
      '',
      'That unit does not exist.',
    ].join('\n');

    const fenced = instructionLines(doc, true).map((l) => l.text);
    expect(fenced).toEqual(['systemctl is-active tugpt-draft-worker']);
    expect(instructionLines(doc, false).length).toBe(7);
  });

  it('no operational instruction names a unit that does not exist', () => {
    const found = offenders();
    expect(
      found,
      `These instructions drive a systemd unit that is not in deploy/systemd/:\n  ` +
        `${found.join('\n  ')}\n\n` +
        `The workers are containers under tugpt.service. Use:\n` +
        `  docker compose -p tugpt ps --status running --services\n` +
        `  docker compose -p tugpt logs --since 1h draft-worker\n` +
        `  systemctl restart tugpt.service            # recreates the stack\n` +
        `  docker compose -p tugpt up -d --force-recreate draft-worker   # after an env edit\n\n` +
        `journalctl against a unit that does not exist prints nothing and exits 0, so a ` +
        `watch step using it reports a clean run no matter what the worker did. If a file ` +
        `genuinely must name one, add it to ALLOWED with the reason.`
    ).toEqual([]);
  });

  it('every allowlist entry still exists and still names one', () => {
    const units = realUnits();
    const stale: string[] = [];
    for (const rel of ALLOWED.keys()) {
      let content: string;
      try {
        content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      const names = content
        .split('\n')
        .flatMap(unitsOnLine)
        .filter((u) => !units.has(u));
      if (names.length === 0) stale.push(`${rel} (no longer names a missing unit — remove the exemption)`);
    }
    expect(stale, `Stale exemptions:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});

describe('the container names the runbooks use are real compose services', () => {
  const compose = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const services = new Set(
    [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
  );

  it('finds the compose services (an empty set would pass everything)', () => {
    expect(services.has('draft-worker')).toBe(true);
    expect(services.has('whatsapp-worker')).toBe(true);
  });

  it('every worker named on a compose command line is a real service', () => {
    // Narrow on purpose. Parsing which bare word is a service name and which is
    // a flag's value is a parser, and a parser that gets it wrong fails open —
    // it captures nothing and reports green. Matching `*-worker` tokens on any
    // `docker compose -p tugpt` line has no such mode, and worker renames are
    // the drift this exists to catch: the runbooks named the systemd units for
    // four days after the units stopped existing.
    const WORKER_TOKEN = /\b[a-z][a-z0-9]*-worker\b/g;
    const bad: string[] = [];

    const docs: string[] = [];
    walk(path.join(REPO_ROOT, 'docs'), ['.md'], docs);

    for (const rel of docs) {
      const content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const { line, text } of instructionLines(content, true)) {
        if (!text.includes('docker compose -p tugpt')) continue;
        for (const m of text.matchAll(WORKER_TOKEN)) {
          if (!services.has(m[0])) bad.push(`${rel}:${line}  ${m[0]}  — ${text.trim()}`);
        }
      }
    }

    expect(
      bad,
      `These compose commands name a worker that is not a service in docker-compose.yml:\n  ` +
        `${bad.join('\n  ')}\n\nServices are: ${[...services].sort().join(', ')}`
    ).toEqual([]);
  });
});
