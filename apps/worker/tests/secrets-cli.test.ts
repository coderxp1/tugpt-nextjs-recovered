import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  parseArgs,
  runSecretsCli,
  fingerprint,
  envVarForKeyId,
  SecretsCliError,
  type SecretsCliDeps,
} from '../src/secrets-cli';

/**
 * What this file is defending is not the happy path — it is the four places a
 * credential could come to rest that the CLI exists to avoid: shell history,
 * the process table, terminal scrollback, and logs.
 *
 * Three of those are structural and testable here: the value must never be
 * accepted as an argument, must never be echoed into an error message, and
 * must never appear in anything the CLI prints. The fourth (echo off) lives in
 * `readSecretFromTty` and is exercised by running the binary; the reader is
 * injected everywhere below so no test touches a terminal.
 */

const KEY_ID = 'platform.v1';
const KEYS = new Map([[KEY_ID, randomBytes(32)]]);
const SECRET = 'gladia_live_9f3c2a1b';

function deps(overrides: Partial<SecretsCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const entered: string[] = [SECRET, SECRET];
  const write = vi.fn(async () => ({ id: 'row-1', keyId: KEY_ID }));

  const base: SecretsCliDeps = {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    },
    readSecret: vi.fn(async () => entered.shift() ?? ''),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    keyRing: () => KEYS,
    write: write as never,
    createClient: (() => ({ from: vi.fn() })) as never,
    ...overrides,
  };

  return { deps: base, out, err, write };
}

describe('parseArgs', () => {
  it('reads the identity and defaults the key id to platform.v1', () => {
    expect(parseArgs(['put', '--provider', 'gladia', '--secret-name', 'api_key'])).toEqual({
      provider: 'gladia',
      secretName: 'api_key',
      keyId: 'platform.v1',
    });
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(
      parseArgs(['put', '--provider=gladia', '--secret-name=api_key', '--key-id=platform.v2'])
    ).toEqual({ provider: 'gladia', secretName: 'api_key', keyId: 'platform.v2' });
  });

  /**
   * The central rule, and the reason rejection beats silently ignoring: a flag
   * that is dropped quietly ends with an operator who believes the key was
   * stored, walks away, and finds out at the first customer voice note — by
   * which time the value is in shell history anyway.
   */
  it.each([
    '--secret',
    '--value',
    '--api-key',
    '--apikey',
    '--key',
    '--plaintext',
    '--password',
    '--token',
  ])('refuses %s rather than ignoring it', (flag) => {
    try {
      parseArgs(['put', '--provider', 'gladia', '--secret-name', 'api_key', flag, SECRET]);
      expect.unreachable('expected SECRET_IN_ARGV');
    } catch (e) {
      expect((e as SecretsCliError).code).toBe('SECRET_IN_ARGV');
    }
  });

  it('refuses the =value form of a value flag too', () => {
    try {
      parseArgs(['put', '--provider', 'gladia', '--secret-name', 'api_key', `--api-key=${SECRET}`]);
      expect.unreachable('expected SECRET_IN_ARGV');
    } catch (e) {
      expect((e as SecretsCliError).code).toBe('SECRET_IN_ARGV');
    }
  });

  /**
   * An error message is a log line. Refusing the flag and then printing its
   * value would move the secret from argv into whatever captured stderr,
   * which is the same leak with an extra step.
   */
  it('does not echo the rejected value back in the error', () => {
    try {
      parseArgs(['put', '--provider', 'gladia', '--secret-name', 'api_key', '--api-key', SECRET]);
      expect.unreachable('expected SECRET_IN_ARGV');
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET);
      expect((e as Error).message).toContain('--api-key');
    }
  });

  it('requires both halves of the identity', () => {
    expect(() => parseArgs(['put', '--provider', 'gladia'])).toThrow(/required/);
    expect(() => parseArgs(['put', '--secret-name', 'api_key'])).toThrow(/required/);
  });

  it('rejects a flag with no value instead of swallowing the next flag', () => {
    expect(() => parseArgs(['put', '--provider', '--secret-name', 'api_key'])).toThrow(
      /--provider needs a value/
    );
  });

  it('rejects a bare positional, which is how a pasted secret would arrive', () => {
    try {
      parseArgs(['put', '--provider', 'gladia', '--secret-name', 'api_key', SECRET]);
      expect.unreachable('expected the positional to be rejected');
    } catch (e) {
      const message = (e as Error).message;
      // Rejecting it is only half of it. This message goes to stderr via the
      // entry point's `err.message`, so quoting the token would move the secret
      // from the shell history into the log — the same leak one step on.
      expect(message).toMatch(/unexpected argument/);
      expect(message).not.toContain(SECRET);
      // 5 because 'put' is argv[0] — the position is what an operator counts.
      expect(message).toContain('position 5');
    }
  });

  it('rejects a value assigned inline to a forbidden flag, without echoing it', () => {
    try {
      parseArgs(['put', '--provider', 'gladia', `--secret=${SECRET}`]);
      expect.unreachable('expected SECRET_IN_ARGV');
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET);
      expect((e as Error).message).toContain('--secret');
    }
  });

  it('rejects an unknown subcommand', () => {
    expect(() => parseArgs(['get', '--provider', 'gladia'])).toThrow(/Usage/);
  });
});

describe('envVarForKeyId', () => {
  // The mapping is not guessable from the id alone, so the error that reports
  // a missing key has to spell it out.
  it('maps a key id back to the variable that would supply it', () => {
    expect(envVarForKeyId('platform.v1')).toBe('TUGPT_SECRET_KEY_PLATFORM_V1');
    expect(envVarForKeyId('org.tenant.v3')).toBe('TUGPT_SECRET_KEY_ORG_TENANT_V3');
  });
});

describe('fingerprint', () => {
  it('is stable for one value and different for another', () => {
    expect(fingerprint(SECRET)).toBe(fingerprint(SECRET));
    expect(fingerprint(SECRET)).not.toBe(fingerprint(`${SECRET}x`));
  });

  it('is short enough to compare by eye and reveals no plaintext', () => {
    expect(fingerprint(SECRET)).toHaveLength(12);
    expect(SECRET).not.toContain(fingerprint(SECRET));
  });
});

describe('runSecretsCli', () => {
  it('stores what was typed, under the requested identity and key', async () => {
    const { deps: d, write } = deps();
    const code = await runSecretsCli(
      ['put', '--provider', 'gladia', '--secret-name', 'api_key'],
      d
    );

    expect(code).toBe(0);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      'gladia',
      'api_key',
      SECRET,
      KEY_ID,
      KEYS
    );
  });

  it('prompts twice and compares, because echo is off and a mispaste is invisible', async () => {
    const { deps: d } = deps();
    await runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d);
    expect(d.readSecret).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when the two entries differ', async () => {
    const entries = [SECRET, `${SECRET}typo`];
    const { deps: d, write } = deps({ readSecret: async () => entries.shift() ?? '' });

    await expect(
      runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d)
    ).rejects.toMatchObject({ code: 'MISMATCH' });
    expect(write).not.toHaveBeenCalled();
  });

  // With echo off, a reported length is the main hint an onlooker gets.
  it('reports neither entry nor its length on a mismatch', async () => {
    const entries = [SECRET, 'x'];
    const { deps: d } = deps({ readSecret: async () => entries.shift() ?? '' });
    const err = await runSecretsCli(
      ['put', '--provider', 'gladia', '--secret-name', 'api_key'],
      d
    ).catch((e) => e);

    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toMatch(/\d+ characters/);
  });

  it('writes nothing for an empty entry', async () => {
    const { deps: d, write } = deps({ readSecret: async () => '' });
    await expect(
      runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d)
    ).rejects.toMatchObject({ code: 'EMPTY' });
    expect(write).not.toHaveBeenCalled();
  });

  it('stops before prompting when the database environment is absent', async () => {
    const { deps: d } = deps({ env: {} });
    await expect(
      runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d)
    ).rejects.toMatchObject({ code: 'MISSING_ENV' });
    expect(d.readSecret).not.toHaveBeenCalled();
  });

  /**
   * Checked before the prompt, not after. Prompting for a credential and then
   * discovering there is no key to encrypt it with means the operator has
   * already pasted it into a terminal for nothing.
   */
  it('stops before prompting when no key exists for the requested key id', async () => {
    const { deps: d } = deps();
    await expect(
      runSecretsCli(
        ['put', '--provider', 'gladia', '--secret-name', 'api_key', '--key-id', 'platform.v9'],
        d
      )
    ).rejects.toMatchObject({ code: 'NO_KEYS' });
    expect(d.readSecret).not.toHaveBeenCalled();
  });

  it('names the environment variable that would fix a missing key', async () => {
    const { deps: d } = deps();
    await expect(
      runSecretsCli(
        ['put', '--provider', 'gladia', '--secret-name', 'api_key', '--key-id', 'platform.v9'],
        d
      )
    ).rejects.toThrow(/TUGPT_SECRET_KEY_PLATFORM_V9/);
  });

  /**
   * The whole point. Everything the CLI emits on either stream is scanned for
   * the plaintext, so a future `console.log` added while debugging turns this
   * red instead of shipping.
   */
  it('never prints the secret on stdout or stderr', async () => {
    const { deps: d, out, err } = deps();
    await runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d);

    for (const line of [...out, ...err]) {
      expect(line).not.toContain(SECRET);
    }
  });

  it('prints the identity, the row, the key and a fingerprint, as machine-readable JSON', async () => {
    const { deps: d, out } = deps();
    await runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d);

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual({
      stored: 'gladia/api_key',
      id: 'row-1',
      keyId: KEY_ID,
      fingerprint: fingerprint(SECRET),
    });
  });

  /**
   * ===========================================================================
   * THE THREE PLACES A SECRET MUST NOT COME TO REST
   * ===========================================================================
   *
   * Shell history, the process table, and the environment. The first two are
   * both argv — history records the command line, and /proc exposes it — and
   * they are covered by the SECRET_IN_ARGV group above plus the assertions
   * here. The third is its own thing and was not previously asserted at all:
   * an env var is inherited by every child process and is readable from
   * /proc/<pid>/environ, so a CLI that stashed the value there would have
   * moved the leak rather than closed it.
   */
  it('leaves the secret out of process.argv on the run that stores it', async () => {
    const argvBefore = [...process.argv];
    const { deps: d } = deps();

    await runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d);

    expect(process.argv).toEqual(argvBefore);
    for (const arg of process.argv) {
      expect(arg).not.toContain(SECRET);
    }
  });

  it('writes the secret into no environment variable, its own or the process\'s', async () => {
    const envBefore = JSON.stringify(process.env);
    const suppliedEnv: NodeJS.ProcessEnv = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    };
    const { deps: d } = deps({ env: suppliedEnv });

    await runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d);

    // Nothing was added to the env it was handed...
    expect(Object.values(suppliedEnv)).not.toContain(SECRET);
    for (const value of Object.values(suppliedEnv)) {
      expect(String(value)).not.toContain(SECRET);
    }
    // ...and process.env is byte-identical to before the run.
    expect(JSON.stringify(process.env)).toBe(envBefore);
    expect(JSON.stringify(process.env)).not.toContain(SECRET);
  });

  /**
   * The whole surface at once. Everything the CLI touched or emitted is
   * searched for the value: both output streams, argv, the environment it was
   * given, and the real process environment. A future change that parks the
   * secret anywhere reachable turns this red without anyone having to think of
   * the specific hiding place first.
   */
  it('leaves the secret in exactly one place: the argument to the encrypting writer', async () => {
    const suppliedEnv: NodeJS.ProcessEnv = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    };
    const { deps: d, out, err, write } = deps({ env: suppliedEnv });

    await runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d);

    const surfaces = [
      ...out,
      ...err,
      ...process.argv,
      ...Object.values(suppliedEnv).map(String),
      ...Object.values(process.env).map(String),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SECRET);
    }

    // The control: it really did reach the writer, so the sweep above is about
    // absence everywhere else rather than about the secret never existing.
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      'gladia',
      'api_key',
      SECRET,
      KEY_ID,
      KEYS
    );
  });

  it('builds the client only after both entries agree', async () => {
    const entries = [SECRET, 'different'];
    const createClient = vi.fn(() => ({ from: vi.fn() }));
    const { deps: d } = deps({
      readSecret: async () => entries.shift() ?? '',
      createClient: createClient as never,
    });

    await expect(
      runSecretsCli(['put', '--provider', 'gladia', '--secret-name', 'api_key'], d)
    ).rejects.toMatchObject({ code: 'MISMATCH' });
    expect(createClient).not.toHaveBeenCalled();
  });
});
