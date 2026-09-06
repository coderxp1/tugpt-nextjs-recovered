import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decodeBytea,
  encodeBytea,
  readPlatformSecret,
  writePlatformSecret,
  SecretStoreError,
} from './secret-store';
import { encryptSecret, SecretCryptoError, type KeyRing } from './secret-crypto';

/**
 * The store is the half of the vault that touches the database, and the thing
 * it is easiest to get wrong is not the cryptography — it is `BYTEA`.
 *
 * PostgREST renders it as PostgreSQL's hex output and accepts the same on the
 * way in, which no document states beside the other. Get it wrong in one
 * direction and the write succeeds while storing the ASCII of the hex string;
 * get it wrong in the other and `createDecipheriv` fails with a message about
 * authentication that sends the reader looking at the key. So the round trip
 * through both encodings is asserted directly, and every assertion about a
 * successful read goes all the way to plaintext rather than stopping at "a
 * Buffer came back".
 */

const KEY_ID = 'platform.v1';
const KEY = randomBytes(32);
const KEYS: KeyRing = new Map([[KEY_ID, KEY]]);
const SECRET = 'gladia_live_9f3c2a1b';

/** A row exactly as PostgREST would render one for this secret. */
function storedRow(overrides: Record<string, unknown> = {}) {
  const sealed = encryptSecret(
    SECRET,
    { organizationId: null, provider: 'gladia', secretName: 'api_key' },
    KEY_ID,
    KEYS
  );
  return {
    algorithm: sealed.algorithm,
    key_id: sealed.keyId,
    iv: encodeBytea(sealed.iv),
    ciphertext: encodeBytea(sealed.ciphertext),
    auth_tag: encodeBytea(sealed.authTag),
    ...overrides,
  };
}

/** Minimal fake of the fluent builder, capturing what was asked for. */
function selectClient(result: { data?: unknown; error?: unknown }) {
  const calls: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    select: vi.fn((cols: string) => {
      calls.select = cols;
      return builder;
    }),
    eq: vi.fn((col: string, val: unknown) => {
      calls[`eq:${col}`] = val;
      return builder;
    }),
    maybeSingle: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
  };
  const from = vi.fn((table: string) => {
    calls.table = table;
    return builder;
  });

  return { calls, from, client: { from } as never };
}

function upsertClient(result: { data?: unknown; error?: unknown }) {
  const calls: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    upsert: vi.fn((row: unknown, opts: unknown) => {
      calls.row = row;
      calls.opts = opts;
      return builder;
    }),
    select: vi.fn(() => builder),
    single: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
  };
  const from = vi.fn((table: string) => {
    calls.table = table;
    return builder;
  });

  return { calls, from, client: { from } as never };
}

describe('bytea encoding', () => {
  it('round-trips arbitrary bytes through the hex representation', () => {
    const bytes = randomBytes(64);
    expect(decodeBytea(encodeBytea(bytes), 'x')).toEqual(bytes);
  });

  it('produces the shape PostgreSQL emits, not base64 or a raw hex string', () => {
    expect(encodeBytea(Buffer.from([0x00, 0xff, 0x10]))).toBe('\\x00ff10');
  });

  it('handles a zero-length value without inventing bytes', () => {
    expect(decodeBytea('\\x', 'x')).toEqual(Buffer.alloc(0));
  });

  // A lenient parser here would hand createDecipheriv a Buffer of the wrong
  // length, which fails with a message about authentication — sending the
  // reader to look at the key instead of at the row.
  it.each([
    ['base64 instead of hex', 'AP8Q'],
    ['hex without the prefix', '00ff10'],
    ['an odd number of digits', '\\x00f'],
    ['a non-hex digit', '\\x00fg'],
    ['a number', 12345],
    ['null', null],
  ])('refuses %s, naming the column', (_label, value) => {
    try {
      decodeBytea(value, 'ciphertext');
      expect.unreachable('expected a MALFORMED_ROW error');
    } catch (e) {
      expect(e).toBeInstanceOf(SecretStoreError);
      expect((e as SecretStoreError).code).toBe('MALFORMED_ROW');
      expect((e as SecretStoreError).message).toMatch(/ciphertext/);
    }
  });
});

describe('readPlatformSecret', () => {
  it('returns the plaintext that was stored', async () => {
    const { client } = selectClient({ data: storedRow() });
    await expect(readPlatformSecret(client, 'gladia', 'api_key', KEYS)).resolves.toBe(SECRET);
  });

  it('queries platform_secrets for exactly the identity it was asked for', async () => {
    const { client, calls } = selectClient({ data: storedRow() });
    await readPlatformSecret(client, 'gladia', 'api_key', KEYS);

    expect(calls.table).toBe('platform_secrets');
    expect(calls['eq:provider']).toBe('gladia');
    expect(calls['eq:secret_name']).toBe('api_key');
  });

  it('never selects a column that does not exist on the table', async () => {
    const { client, calls } = selectClient({ data: storedRow() });
    await readPlatformSecret(client, 'gladia', 'api_key', KEYS);

    const selected = String(calls.select).split(',').map((c) => c.trim());
    expect(selected.sort()).toEqual(
      ['algorithm', 'auth_tag', 'ciphertext', 'iv', 'key_id'].sort()
    );
  });

  // Throwing rather than returning null, for the same reason decryptSecret
  // does: a nullable return invites `?? ''`, and an empty API key is exactly
  // the value that turns a missing credential into a request authenticated as
  // nobody.
  it('throws NOT_FOUND for a missing row instead of returning null', async () => {
    const { client } = selectClient({ data: null });
    await expect(readPlatformSecret(client, 'gladia', 'api_key', KEYS)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('names the missing identity, because that is what makes it diagnosable', async () => {
    const { client } = selectClient({ data: null });
    await expect(readPlatformSecret(client, 'gladia', 'api_key', KEYS)).rejects.toThrow(
      /gladia\/api_key/
    );
  });

  it('does not forward the driver error message, which can carry the statement', async () => {
    const { client } = selectClient({
      error: { message: 'select ... where key_id = \'platform.v1\'', code: '42501' },
    });
    const err = await readPlatformSecret(client, 'gladia', 'api_key', KEYS).catch((e) => e);
    expect(err.code).toBe('QUERY_FAILED');
    expect(err.message).not.toMatch(/select/);
  });

  it('refuses a row stored under an algorithm it does not implement', async () => {
    const { client } = selectClient({ data: storedRow({ algorithm: 'aes-128-cbc' }) });
    await expect(readPlatformSecret(client, 'gladia', 'api_key', KEYS)).rejects.toMatchObject({
      code: 'MALFORMED_ROW',
    });
  });

  it('refuses a row with no key_id, which is a row nothing can ever rotate', async () => {
    const { client } = selectClient({ data: storedRow({ key_id: null }) });
    await expect(readPlatformSecret(client, 'gladia', 'api_key', KEYS)).rejects.toMatchObject({
      code: 'MALFORMED_ROW',
    });
  });

  it('reports an unknown key_id as such rather than as a decrypt failure', async () => {
    const { client } = selectClient({ data: storedRow({ key_id: 'platform.v2' }) });
    const err = await readPlatformSecret(client, 'gladia', 'api_key', KEYS).catch((e) => e);
    expect(err).toBeInstanceOf(SecretCryptoError);
    expect(err.code).toBe('UNKNOWN_KEY_ID');
  });

  /**
   * The AAD claim, exercised through the store rather than only the cipher.
   * A ciphertext written for one identity must not decrypt as another, which
   * is what stops a mistaken backfill or a restore that crossed rows from
   * handing out the wrong credential. Read back under a different provider
   * name, the tag check fails.
   */
  it('will not decrypt a row read under a different identity', async () => {
    const { client } = selectClient({ data: storedRow() });
    const err = await readPlatformSecret(client, 'langdock', 'api_key', KEYS).catch((e) => e);
    expect(err).toBeInstanceOf(SecretCryptoError);
    expect(err.code).toBe('DECRYPT_FAILED');
  });
});

describe('writePlatformSecret', () => {
  it('stores ciphertext, and nothing resembling the plaintext', async () => {
    const { client, calls } = upsertClient({ data: { id: 'row-1' } });
    await writePlatformSecret(client, 'gladia', 'api_key', SECRET, KEY_ID, KEYS);

    const row = calls.row as Record<string, string>;
    const wire = JSON.stringify(calls.row);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain(Buffer.from(SECRET).toString('hex'));
    expect(row.ciphertext.startsWith('\\x')).toBe(true);
  });

  it('writes a row the reader can decrypt', async () => {
    const { client: writer, calls } = upsertClient({ data: { id: 'row-1' } });
    await writePlatformSecret(writer, 'gladia', 'api_key', SECRET, KEY_ID, KEYS);

    // Feed exactly what was written back through the read path.
    const { client: reader } = selectClient({ data: calls.row });
    await expect(readPlatformSecret(reader, 'gladia', 'api_key', KEYS)).resolves.toBe(SECRET);
  });

  it('upserts on the table\'s unique index, so rotation is one call', async () => {
    const { client, calls } = upsertClient({ data: { id: 'row-1' } });
    await writePlatformSecret(client, 'gladia', 'api_key', SECRET, KEY_ID, KEYS);

    expect(calls.table).toBe('platform_secrets');
    expect(calls.opts).toMatchObject({ onConflict: 'provider,secret_name' });
  });

  it('records which key encrypted the row, which is what makes retiring one possible', async () => {
    const { client, calls } = upsertClient({ data: { id: 'row-1' } });
    const result = await writePlatformSecret(client, 'gladia', 'api_key', SECRET, KEY_ID, KEYS);

    expect((calls.row as Record<string, string>).key_id).toBe(KEY_ID);
    expect(result.keyId).toBe(KEY_ID);
  });

  it('writes a 12-byte IV and a 16-byte tag, the sizes the CHECK constraint enforces', async () => {
    const { client, calls } = upsertClient({ data: { id: 'row-1' } });
    await writePlatformSecret(client, 'gladia', 'api_key', SECRET, KEY_ID, KEYS);

    const row = calls.row as Record<string, string>;
    expect(decodeBytea(row.iv, 'iv')).toHaveLength(12);
    expect(decodeBytea(row.auth_tag, 'auth_tag')).toHaveLength(16);
  });

  it('uses a fresh IV per write, because GCM nonce reuse under one key is fatal', async () => {
    const a = upsertClient({ data: { id: 'row-1' } });
    const b = upsertClient({ data: { id: 'row-1' } });
    await writePlatformSecret(a.client, 'gladia', 'api_key', SECRET, KEY_ID, KEYS);
    await writePlatformSecret(b.client, 'gladia', 'api_key', SECRET, KEY_ID, KEYS);

    expect((a.calls.row as Record<string, string>).iv).not.toBe(
      (b.calls.row as Record<string, string>).iv
    );
  });

  // Every one of these fails before the request. A write that half-lands is a
  // row that looks configured and authenticates as nobody.
  it('rejects an unknown key id without touching the database', async () => {
    const { client, from } = upsertClient({ data: { id: 'row-1' } });
    await expect(
      writePlatformSecret(client, 'gladia', 'api_key', SECRET, 'platform.v9', KEYS)
    ).rejects.toMatchObject({ code: 'UNKNOWN_KEY_ID' });
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects an empty secret without touching the database', async () => {
    const { client, from } = upsertClient({ data: { id: 'row-1' } });
    await expect(
      writePlatformSecret(client, 'gladia', 'api_key', '', KEY_ID, KEYS)
    ).rejects.toMatchObject({ code: 'EMPTY_PLAINTEXT' });
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects a key of the wrong length rather than deriving one', async () => {
    const short: KeyRing = new Map([[KEY_ID, randomBytes(16)]]);
    const { client, from } = upsertClient({ data: { id: 'row-1' } });
    await expect(
      writePlatformSecret(client, 'gladia', 'api_key', SECRET, KEY_ID, short)
    ).rejects.toMatchObject({ code: 'BAD_KEY_LENGTH' });
    expect(from).not.toHaveBeenCalled();
  });

  it('reports a failed write rather than returning a row id it does not have', async () => {
    const { client } = upsertClient({ error: { message: 'permission denied' } });
    await expect(
      writePlatformSecret(client, 'gladia', 'api_key', SECRET, KEY_ID, KEYS)
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });
  });
});
