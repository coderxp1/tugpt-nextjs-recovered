import { createHash } from 'node:crypto';
import { createAdminSupabaseClient } from '@tugpt/database';
import { keyRingFromEnv, writePlatformSecret, type KeyRing } from '@tugpt/security';

/**
 * @file secrets-cli.ts
 * @description Puts a vendor credential into `platform_secrets` from a terminal.
 *
 * ---------------------------------------------------------------------------
 * THE THREATS THIS IS SHAPED BY
 * ---------------------------------------------------------------------------
 *
 * All four are about where a secret comes to rest, not about cryptography:
 *
 *   1. **Shell history.** A key passed as `--api-key sk-...` is in
 *      `~/.bash_history` forever, on a box several people have root on. So the
 *      value is NEVER an argument: `parseArgs` rejects anything that looks like
 *      one, rather than silently ignoring it, because a flag that is quietly
 *      dropped is an operator who believes the key was stored.
 *
 *   2. **The process table.** Argv is world-readable through `/proc`, so even
 *      a one-off invocation is visible to any other process for its lifetime.
 *      Same defence.
 *
 *   3. **Terminal scrollback and screen shares.** The prompt reads with echo
 *      off, and prompts go to stderr so that stdout carries only the result —
 *      a redirect to a file cannot accidentally capture the prompt.
 *
 *   4. **Logs.** Nothing here prints the plaintext, at any verbosity. What it
 *      prints instead is a truncated SHA-256 fingerprint, which lets an
 *      operator confirm months later that the stored key is the one they meant
 *      without the key appearing anywhere.
 *
 * A fifth, handled by the store rather than here: the database statement log.
 * `writePlatformSecret` encrypts before the request, so only opaque bytes
 * cross the wire.
 *
 * ---------------------------------------------------------------------------
 * TYPED TWICE
 * ---------------------------------------------------------------------------
 *
 * With echo off there is no way to see a mispaste, and a wrong key does not
 * fail here — it fails later as a 401 from the vendor, on a path that looks
 * like a provider outage. So the value is entered twice and compared, and a
 * mismatch aborts without writing.
 */

const DEFAULT_KEY_ID = 'platform.v1';

/** Control bytes the raw-mode reader has to recognise. */
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = '\u007f';

export interface SecretsCliDeps {
  readonly env: NodeJS.ProcessEnv;
  /** Prompts and reads with echo off. Injected so tests never touch a TTY. */
  readonly readSecret: (prompt: string) => Promise<string>;
  /** Result output. Never receives plaintext. */
  readonly out: (line: string) => void;
  /** Diagnostics and prompts. Never receives plaintext. */
  readonly err: (line: string) => void;
  readonly keyRing?: (env: NodeJS.ProcessEnv) => KeyRing;
  readonly write?: typeof writePlatformSecret;
  readonly createClient?: typeof createAdminSupabaseClient;
}

export class SecretsCliError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'USAGE'
      | 'SECRET_IN_ARGV'
      | 'MISSING_ENV'
      | 'NO_KEYS'
      | 'MISMATCH'
      | 'EMPTY'
  ) {
    super(message);
    this.name = 'SecretsCliError';
  }
}

const USAGE = `Usage:
  secrets-cli put --provider <name> --secret-name <name> [--key-id <id>]

The secret itself is never an argument. It is typed at the prompt, twice.

Environment (from /etc/tugpt/worker.env):
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  TUGPT_SECRET_KEY_<ID>   base64-encoded 32 bytes; TUGPT_SECRET_KEY_PLATFORM_V1
                          is the key id platform.v1`;

interface PutArgs {
  provider: string;
  secretName: string;
  keyId: string;
}

/**
 * Any flag whose name suggests it carries the value itself.
 *
 * Rejected rather than ignored. An unknown flag that is dropped silently ends
 * with an operator believing the key was stored, walking away, and finding out
 * at the first customer voice note.
 */
const FORBIDDEN_VALUE_FLAGS = [
  '--secret',
  '--value',
  '--api-key',
  '--apikey',
  '--key',
  '--plaintext',
  '--password',
  '--token',
];

export function parseArgs(argv: readonly string[]): PutArgs {
  if (argv[0] !== 'put') {
    throw new SecretsCliError(USAGE, 'USAGE');
  }

  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) {
      // The offending token is NOT quoted back. This is the branch a pasted
      // credential actually lands on — `put --provider ... <the key>`, which
      // the test below feeds a real secret through — and the entry point writes
      // err.message straight to stderr, which in a journald-captured session is
      // a log. The SECRET_IN_ARGV path already refuses to echo its value for
      // exactly that reason; a positional rejection that echoes one would put
      // the key in the log the whole CLI is written to keep it out of.
      // The position identifies the argument well enough to act on.
      throw new SecretsCliError(
        `unexpected argument at position ${i} — only --provider, --secret-name ` +
          `and --key-id take values, and a secret is typed at the prompt, never passed here\n\n${USAGE}`,
        'USAGE'
      );
    }

    // Matched on the flag NAME, before any value is read, and the value is
    // never echoed back in the error — an error message is a log line.
    const eq = flag.indexOf('=');
    const name = eq === -1 ? flag : flag.slice(0, eq);
    if (FORBIDDEN_VALUE_FLAGS.includes(name.toLowerCase())) {
      throw new SecretsCliError(
        `${name} is not accepted: a secret passed as an argument is written to shell history and is readable in the process table. Rerun without it and type the value at the prompt.`,
        'SECRET_IN_ARGV'
      );
    }

    if (eq !== -1) {
      args[flag.slice(2, eq)] = flag.slice(eq + 1);
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new SecretsCliError(`${flag} needs a value`, 'USAGE');
      }
      args[flag.slice(2)] = value;
      i += 1;
    }
  }

  const provider = args.provider;
  const secretName = args['secret-name'];
  if (!provider || !secretName) {
    throw new SecretsCliError(`--provider and --secret-name are required\n\n${USAGE}`, 'USAGE');
  }

  return { provider, secretName, keyId: args['key-id'] || DEFAULT_KEY_ID };
}

/**
 * The env var name that would supply a given key id.
 *
 * The mapping is not guessable from the id alone — `keyRingFromEnv` lowercases
 * and turns `_` into `.` — so an error that names the id without naming the
 * variable leaves the operator to reverse it.
 */
export function envVarForKeyId(keyId: string): string {
  return `TUGPT_SECRET_KEY_${keyId.toUpperCase().replace(/\./g, '_')}`;
}

/** First 12 hex characters of the SHA-256. Enough to compare, useless to an attacker. */
export function fingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 12);
}

export async function runSecretsCli(
  argv: readonly string[],
  deps: SecretsCliDeps
): Promise<number> {
  const { provider, secretName, keyId } = parseArgs(argv);

  const url = deps.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = deps.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new SecretsCliError(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Run this with the worker environment file applied.',
      'MISSING_ENV'
    );
  }

  const keys = (deps.keyRing ?? keyRingFromEnv)(deps.env);
  if (!keys.has(keyId)) {
    throw new SecretsCliError(
      `no key for key id "${keyId}". Set ${envVarForKeyId(keyId)} to a base64-encoded 32-byte key.`,
      'NO_KEYS'
    );
  }

  deps.err(`Storing ${provider}/${secretName} under key ${keyId}.`);
  const first = await deps.readSecret(`${provider} ${secretName}: `);
  if (first.length === 0) {
    throw new SecretsCliError('empty secret; nothing written', 'EMPTY');
  }

  const second = await deps.readSecret('confirm: ');
  if (first !== second) {
    // The length of neither entry is reported. With echo off a length is the
    // main hint an onlooker gets, and this runs on shared terminals.
    throw new SecretsCliError('the two entries differ; nothing written', 'MISMATCH');
  }

  const client = (deps.createClient ?? createAdminSupabaseClient)(url, serviceRoleKey);
  const written = await (deps.write ?? writePlatformSecret)(
    client as never,
    provider,
    secretName,
    first,
    keyId,
    keys
  );

  deps.out(
    JSON.stringify({
      stored: `${provider}/${secretName}`,
      id: written.id,
      keyId: written.keyId,
      fingerprint: fingerprint(first),
    })
  );
  deps.err('Stored. Restart the workers to pick it up.');
  return 0;
}

/**
 * Reads one line from a TTY with echo off.
 *
 * Raw mode and a byte loop rather than `readline`: muting readline means
 * overriding its private `_writeToOutput`, which is undocumented and has
 * changed shape between Node versions. What that would buy — line editing —
 * is worth nothing for a pasted credential, and getting it wrong echoes the
 * key to the screen.
 *
 * The terminal is always restored, including on Ctrl-C, because a shell left
 * in raw mode is the kind of damage an operator remembers.
 */
export function readSecretFromTty(prompt: string): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    // Piped input: read it all, take the first line. No confirmation is
    // possible and none is faked — the operator chose automation.
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        data += chunk;
      });
      stdin.on('end', () => resolve(data.split('\n', 1)[0]));
      stdin.on('error', reject);
    });
  }

  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let buffer = '';
    const finish = (fn: () => void): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
      fn();
    };

    function onData(chunk: string): void {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === CTRL_D) {
          const value = buffer;
          buffer = '';
          finish(() => resolve(value));
          return;
        }
        if (ch === CTRL_C) {
          buffer = '';
          finish(() => reject(new SecretsCliError('cancelled; nothing written', 'EMPTY')));
          return;
        }
        if (ch === BACKSPACE || ch === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    }

    stdin.on('data', onData);
  });
}

/* c8 ignore start -- process entry point, exercised by running the binary */
if (require.main === module) {
  runSecretsCli(process.argv.slice(2), {
    env: process.env,
    readSecret: readSecretFromTty,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
/* c8 ignore stop */
