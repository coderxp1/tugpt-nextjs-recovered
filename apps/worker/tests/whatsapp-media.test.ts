import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  WhatsAppMediaClient,
  MediaFetchError,
  DEFAULT_MAX_MEDIA_BYTES,
  DEFAULT_GRAPH_VERSION,
  type MediaErrorCode,
} from '../src/whatsapp-media';

/**
 * The approval this file implements was narrow and specific: read-only,
 * download-only, existing credentials, a size cap before download because
 * Gladia bills per second. So the assertions are organised around the four
 * things that would violate it rather than around the happy path:
 *
 *   1. It can only GET. (`sends only GET requests`)
 *   2. The ceiling holds even when Meta's declared size is missing or lying.
 *   3. The access token goes to Meta's hosts and nowhere else.
 *   4. Nothing that leaves this module carries the short-lived media URL.
 *
 * Every negative case is paired with a positive control on the same fixture,
 * because "no download happened" and "no download would have happened anyway"
 * are indistinguishable without one.
 */

const TOKEN = 'EAAG-graph-access-token';
const MEDIA_ID = '1234567890';
const AUDIO = Buffer.from('OggS-fake-voice-note-bytes');
const AUDIO_SHA = createHash('sha256').update(AUDIO).digest('hex');
const CDN_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc&ext=1';

let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ID,
    url: CDN_URL,
    mime_type: 'audio/ogg; codecs=opus',
    sha256: AUDIO_SHA,
    file_size: AUDIO.length,
    messaging_product: 'whatsapp',
    ...overrides,
  };
}

/** A body delivered in `chunkCount` pieces, so the streaming ceiling is real. */
function streamed(bytes: Uint8Array, chunkCount = 4, headers: Record<string, string> = {}): Response {
  const size = Math.ceil(bytes.length / chunkCount);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.subarray(i, Math.min(i + size, bytes.length)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

function client(overrides: Record<string, unknown> = {}) {
  return new WhatsAppMediaClient({ accessToken: TOKEN, ...overrides });
}

async function expectFailure(
  promise: Promise<unknown>,
  code: MediaErrorCode,
  detail?: RegExp
): Promise<MediaFetchError> {
  try {
    await promise;
    expect.unreachable(`expected a ${code} failure`);
  } catch (e) {
    expect(e).toBeInstanceOf(MediaFetchError);
    const err = e as MediaFetchError;
    expect(err.code).toBe(code);
    if (detail) expect(err.detail ?? '').toMatch(detail);
    return err;
  }
  throw new Error('unreachable');
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WhatsAppMediaClient — construction', () => {
  it('refuses an empty token rather than sending an unauthenticated request', () => {
    expect(() => new WhatsAppMediaClient({ accessToken: '' })).toThrow(MediaFetchError);
  });

  it('says where the token is supposed to come from', () => {
    try {
      new WhatsAppMediaClient({ accessToken: '' });
      expect.unreachable('expected a throw');
    } catch (e) {
      expect((e as MediaFetchError).detail).toMatch(/platform_secrets/);
    }
  });

  it('defaults the ceiling to 8 MiB, under Meta\'s own 16 MiB audio limit', () => {
    expect(client().maxBytes).toBe(DEFAULT_MAX_MEDIA_BYTES);
    expect(DEFAULT_MAX_MEDIA_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('WhatsAppMediaClient — fetchAudio', () => {
  it('returns the bytes, the mime type, and a digest computed from the bytes', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(streamed(AUDIO));

    const result = await client().fetchAudio(MEDIA_ID);

    expect(Buffer.from(result.bytes)).toEqual(AUDIO);
    expect(result.mimeType).toBe('audio/ogg; codecs=opus');
    expect(result.sha256).toBe(AUDIO_SHA);
    expect(result.declaredSizeBytes).toBe(AUDIO.length);
  });

  it('asks the pinned Graph version for the media id', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(streamed(AUDIO));
    await client().fetchAudio(MEDIA_ID);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/${MEDIA_ID}`
    );
  });

  /**
   * The scope constraint, mechanically. The approval was download-only, and
   * "it currently only reads" is a property a later edit can remove without
   * anyone noticing. Asserted on every request the client makes.
   */
  it('sends only GET requests, never a POST', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(streamed(AUDIO));
    await client().fetchAudio(MEDIA_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    }
  });

  it('authenticates both requests with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(streamed(AUDIO));
    await client().fetchAudio(MEDIA_ID);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.headers['User-Agent']).toBeTruthy();
    }
  });

  it('passes the abort signal to both requests', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(streamed(AUDIO));
    await client().fetchAudio(MEDIA_ID, controller.signal);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBe(controller.signal);
    }
  });
});

describe('WhatsAppMediaClient — the size ceiling', () => {
  /**
   * The cheap refusal, and the one that actually saves money: no transfer at
   * all. The positive control is every other test in this file, all of which
   * reach the second fetch on the same fixture shape.
   */
  it('refuses a declared size over the ceiling without downloading anything', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata({ file_size: 20 * 1024 * 1024 })));

    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_TOO_LARGE', /over the/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a declared size exactly at the ceiling (the boundary is inclusive)', async () => {
    const bytes = new Uint8Array(1024).fill(7);
    fetchMock
      .mockResolvedValueOnce(json(metadata({ file_size: 1024, sha256: undefined })))
      .mockResolvedValueOnce(streamed(bytes));

    await expect(client({ maxBytes: 1024 }).fetchAudio(MEDIA_ID)).resolves.toMatchObject({
      declaredSizeBytes: 1024,
    });
  });

  it('reads file_size when Graph reports it as a numeric string', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata({ file_size: '20971520' })));
    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_TOO_LARGE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The check that cannot be lied to. `file_size` is a number a third party
   * supplied; if it is absent or understated, the only thing standing between
   * a worker and unbounded memory is the byte count as it arrives.
   */
  it('stops mid-transfer when the real body exceeds the ceiling despite an honest-looking size', async () => {
    const big = new Uint8Array(4096).fill(1);
    fetchMock
      .mockResolvedValueOnce(json(metadata({ file_size: 100, sha256: undefined })))
      .mockResolvedValueOnce(streamed(big, 8));

    await expectFailure(client({ maxBytes: 1024 }).fetchAudio(MEDIA_ID), 'MEDIA_TOO_LARGE', /mid-transfer/);
  });

  it('enforces the ceiling when Graph reports no size at all', async () => {
    const big = new Uint8Array(4096).fill(1);
    fetchMock
      .mockResolvedValueOnce(json(metadata({ file_size: undefined, sha256: undefined })))
      .mockResolvedValueOnce(streamed(big, 8));

    await expectFailure(client({ maxBytes: 1024 }).fetchAudio(MEDIA_ID), 'MEDIA_TOO_LARGE');
  });

  // The positive control for the two above: the same missing-size fixture
  // succeeds when the body is genuinely small, so "too large" is a statement
  // about the body and not about the missing field.
  it('downloads normally when the size is missing and the body is small', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata({ file_size: undefined })))
      .mockResolvedValueOnce(streamed(AUDIO));

    const result = await client({ maxBytes: 1024 }).fetchAudio(MEDIA_ID);
    expect(Buffer.from(result.bytes)).toEqual(AUDIO);
    expect(result.declaredSizeBytes).toBeUndefined();
  });

  /**
   * WHAT EXACTLY HAPPENS ON AN OVERSIZED DOWNLOAD.
   *
   * Asserted as three separate facts, because "it throws" is the least
   * interesting one and the other two are where the cost lives:
   *
   *   1. Pulling STOPS. The reader is not drained to the end and then
   *      measured — that would move every byte of a two-hour file across the
   *      wire before declining it, which is most of what the cap exists to
   *      avoid.
   *   2. The body is CANCELLED, so the connection is released rather than left
   *      for the runtime to reap.
   *   3. The failure is MEDIA_TOO_LARGE, which the worker treats as terminal
   *      on the first attempt — no retry, and no partial bytes returned to
   *      anyone.
   */
  it('stops pulling, cancels the body, and returns nothing when the ceiling is passed', async () => {
    let pulls = 0;
    let cancelled = false;
    const CHUNKS = 20;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > CHUNKS) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(512).fill(9));
      },
      cancel() {
        cancelled = true;
      },
    });

    fetchMock
      .mockResolvedValueOnce(json(metadata({ file_size: undefined, sha256: undefined })))
      .mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const err = await expectFailure(
      client({ maxBytes: 1024 }).fetchAudio(MEDIA_ID),
      'MEDIA_TOO_LARGE',
      /mid-transfer/
    );

    // 1. Stopped early: three pulls at 512 bytes crosses a 1024-byte ceiling,
    //    and the remaining seventeen chunks were never asked for.
    expect(pulls).toBeLessThan(CHUNKS);
    expect(pulls).toBeLessThanOrEqual(4);

    // 2. The body was cancelled, not abandoned.
    expect(cancelled).toBe(true);

    // 3. Nothing partial escaped.
    expect(err.code).toBe('MEDIA_TOO_LARGE');
    expect((err as unknown as { bytes?: unknown }).bytes).toBeUndefined();
  });

  // The control for the assertion above: the same stream shape, under a
  // ceiling it fits inside, IS drained to the end and is not cancelled. Without
  // it, "stopped early" would be satisfied by a reader that never pulls.
  it('control: a body under the ceiling is read to completion and not cancelled', async () => {
    let pulls = 0;
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 2) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(512).fill(9));
      },
      cancel() {
        cancelled = true;
      },
    });

    fetchMock
      .mockResolvedValueOnce(json(metadata({ file_size: undefined, sha256: undefined })))
      .mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const result = await client({ maxBytes: 4096 }).fetchAudio(MEDIA_ID);

    expect(result.bytes.byteLength).toBe(1024);
    expect(cancelled).toBe(false);
    expect(pulls).toBeGreaterThan(2);
  });

  it('refuses on an over-ceiling Content-Length before reading the body', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata({ file_size: undefined, sha256: undefined })))
      .mockResolvedValueOnce(streamed(new Uint8Array(64), 1, { 'content-length': '9999999' }));

    await expectFailure(client({ maxBytes: 1024 }).fetchAudio(MEDIA_ID), 'MEDIA_TOO_LARGE', /declares/);
  });
});

describe('WhatsAppMediaClient — where the token may be sent', () => {
  it.each([
    ['a non-Meta host', 'https://evil.example.com/media.ogg'],
    ['a lookalike suffix', 'https://evil-fbcdn.net/media.ogg'],
    ['a host with Meta as a path', 'https://evil.example.com/lookaside.fbsbx.com/x.ogg'],
    ['plain http', 'http://lookaside.fbsbx.com/x.ogg'],
  ])('refuses to send the token to %s', async (_label, url) => {
    fetchMock.mockResolvedValueOnce(json(metadata({ url })));

    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_MALFORMED');
    // The refusal is what matters; that it happened before the request is what
    // makes it a refusal rather than a report.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://lookaside.fbsbx.com/x.ogg',
    'https://scontent.xx.fbcdn.net/x.ogg',
    'https://mmg.whatsapp.net/x.ogg',
  ])('allows %s (control: the refusals above are about the host)', async (url) => {
    fetchMock
      .mockResolvedValueOnce(json(metadata({ url, sha256: undefined })))
      .mockResolvedValueOnce(streamed(AUDIO));

    await expect(client().fetchAudio(MEDIA_ID)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never puts the media URL into an error, where it would be logged', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata({ url: 'https://evil.example.com/secret-handle' })));
    const err = await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_MALFORMED');
    expect(`${err.message}${err.detail}`).not.toContain('secret-handle');
    expect(`${err.message}${err.detail}`).not.toContain('evil.example.com');
  });
});

describe('WhatsAppMediaClient — integrity', () => {
  /**
   * A truncated transfer produces a shorter file that decodes to a shorter
   * transcript: plausible, wrong, and invisible to the reviewer who approves a
   * draft written from it. The digest is the only thing that catches it.
   */
  it('refuses bytes that do not match the digest Meta reported', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(streamed(AUDIO.subarray(0, 10)));

    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_INTEGRITY', /did not match/);
  });

  it('accepts a digest reported in upper case', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata({ sha256: AUDIO_SHA.toUpperCase() })))
      .mockResolvedValueOnce(streamed(AUDIO));

    await expect(client().fetchAudio(MEDIA_ID)).resolves.toMatchObject({ sha256: AUDIO_SHA });
  });

  // Refusing every file on a Graph version that stops sending the field would
  // be a self-inflicted outage; a mismatch is still terminal.
  it('proceeds when Meta reports no digest, still computing one from the bytes', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata({ sha256: undefined })))
      .mockResolvedValueOnce(streamed(AUDIO));

    await expect(client().fetchAudio(MEDIA_ID)).resolves.toMatchObject({ sha256: AUDIO_SHA });
  });

  it('refuses an empty body rather than uploading nothing to a paid endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata({ sha256: undefined, file_size: 0 })))
      .mockResolvedValueOnce(streamed(new Uint8Array(0), 1));

    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_MALFORMED', /no bytes/);
  });
});

describe('WhatsAppMediaClient — failure classification', () => {
  it.each([
    [401, 'MEDIA_AUTH_ERROR'],
    [403, 'MEDIA_AUTH_ERROR'],
    [404, 'MEDIA_UNAVAILABLE'],
    [410, 'MEDIA_UNAVAILABLE'],
    [429, 'MEDIA_TRANSIENT'],
    [500, 'MEDIA_TRANSIENT'],
    [503, 'MEDIA_TRANSIENT'],
    [400, 'MEDIA_UNAVAILABLE'],
  ])('maps a metadata %i to %s', async (status, code) => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'nope' } }, status));
    const err = await expectFailure(client().fetchAudio(MEDIA_ID), code as MediaErrorCode);
    expect(err.httpStatus).toBe(status);
  });

  it('maps a download failure with the same taxonomy as a metadata failure', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({ error: 'gone' }, 410));

    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_UNAVAILABLE');
  });

  it('treats a network failure as transient, so a deploy does not dead-letter a job', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_TRANSIENT');
  });

  it('treats an abort as transient for the same reason', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abort);
    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_TRANSIENT');
  });

  it('rejects metadata that is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 200 }));
    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_MALFORMED', /not JSON/);
  });

  it('rejects metadata with no url instead of fetching undefined', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata({ url: undefined })));
    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_MALFORMED', /no url/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unparseable url', async () => {
    fetchMock.mockResolvedValueOnce(json(metadata({ url: 'not a url' })));
    await expectFailure(client().fetchAudio(MEDIA_ID), 'MEDIA_MALFORMED', /unparseable/);
  });

  it('falls back to a generic mime type rather than failing on a missing one', async () => {
    fetchMock
      .mockResolvedValueOnce(json(metadata({ mime_type: undefined, sha256: undefined })))
      .mockResolvedValueOnce(streamed(AUDIO));

    await expect(client().fetchAudio(MEDIA_ID)).resolves.toMatchObject({
      mimeType: 'application/octet-stream',
    });
  });
});
