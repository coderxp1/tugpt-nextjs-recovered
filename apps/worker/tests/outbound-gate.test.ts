import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { GladiaAdapter } from '@tugpt/ai-providers';
import { WhatsAppMediaClient } from '../src/whatsapp-media';
import { TranscriptionWorker } from '../src/transcription-worker';
import {
  createMockClient,
  MOCK_JOB_ROW,
  MOCK_QUEUE_MESSAGE,
} from './fixtures/transcription-fixtures';

/**
 * ===========================================================================
 * THE SENTENCE THIS FILE MAKES MECHANICAL
 * ===========================================================================
 *
 * The 2026-09-04 media-fetch approval was explicit and narrow: the
 * transcription worker may call Meta's Graph media endpoint to download
 * inbound audio — read-only, download-only, using existing credentials — and
 * **this does not open outbound messaging**. The `whatsapp_integration` gate
 * is untouched.
 *
 * "It currently only reads" is a property a later edit removes without anyone
 * noticing, and the worker now holds a Graph access token, which is exactly
 * the credential a send would need. So the constraint is asserted twice, in
 * two different ways, because neither alone is enough.
 *
 * FIRST, AGAINST THE SOURCE (this describe block):
 *
 *   * No file under apps/worker/src references Meta's send endpoint.
 *   * No file under apps/worker/src issues a POST to a Graph host.
 *   * `whatsapp-media.ts`, which holds the token, names no method but GET.
 *
 * A grep-based guard has one failure mode worth more than the guard itself:
 * matching nothing, forever, while reading as protection. The first test below
 * is the control for that — it asserts the scan actually found the files it is
 * supposed to be scanning, and that a known string in them is detectable.
 *
 * SECOND, AGAINST WHAT ACTUALLY HAPPENS (the describe block after it): the real
 * client and the real worker are run against a stubbed `fetch`, and every
 * request that reached a Meta host is inspected. That is the half that survives
 * a POST arriving through a helper or a library, which no grep models.
 */

const SRC = path.resolve(__dirname, '..', 'src');
const MEDIA_FILE = path.join(SRC, 'whatsapp-media.ts');

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Strip block and line comments, so prose about POSTing is not a finding. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the transcription path cannot send a WhatsApp message', () => {
  /**
   * The control. Without it, a scan that walked the wrong directory would
   * report "no violations" forever.
   */
  it('is actually scanning the worker source', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((f) => path.basename(f))).toContain('whatsapp-media.ts');
    // A string that is definitely present, so a broken reader fails here
    // rather than passing every assertion below.
    expect(code(read(MEDIA_FILE))).toContain('graph.facebook.com');
  });

  it('references no Meta send endpoint anywhere in the worker', () => {
    const offenders = sourceFiles().filter((f) => /\/messages\b/.test(code(read(f))));
    expect(
      offenders.map((f) => path.relative(SRC, f)),
      'a Graph /messages reference appeared in the worker; that is the outbound endpoint'
    ).toEqual([]);
  });

  it('issues no POST to a Graph host from anywhere in the worker', () => {
    const offenders = sourceFiles().filter((f) => {
      const body = code(read(f));
      if (!/graph\.facebook\.com|fbcdn|fbsbx|whatsapp\.net/.test(body)) return false;
      return /method:\s*'(POST|PUT|PATCH|DELETE)'/.test(body);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  /**
   * The strictest of the three, aimed at the one file that holds the token:
   * every HTTP method it names must be GET. Not "no POST" — any method that is
   * not GET, so a future PUT or DELETE is caught by the same line.
   */
  it('uses only GET in the file that holds the Graph access token', () => {
    const methods = [...code(read(MEDIA_FILE)).matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);

    expect(methods.length, 'no HTTP method found — has the file moved or changed shape?').toBeGreaterThan(0);
    expect([...new Set(methods)]).toEqual(['GET']);
  });

});

/**
 * ===========================================================================
 * THE RUNTIME HALF
 * ===========================================================================
 *
 * Everything above reads source. Source scans catch a POST somebody types, and
 * they cannot catch one that arrives through a helper, a library, or a code
 * path a grep does not model — and the first draft of this file proved the
 * weakness from the other side: an assertion that no line matched `body:`
 * failed on `let body: Record<string, unknown>`, a local variable holding a
 * parsed RESPONSE. A regex cannot tell a request body from a response one.
 *
 * So the claim is made the other way as well: run the real client and the real
 * worker against a stubbed `fetch`, and assert on what was actually attempted.
 * Every request that reached a Meta host is inspected, not just the ones this
 * file expected to see.
 *
 * Gladia legitimately receives a POST (the audio upload), so the assertion is
 * host-scoped rather than global — which is the honest shape of the rule:
 * *nothing is sent to Meta*, not *nothing is ever posted*.
 */

const META_HOST = /(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|whatsapp\.net)$/;

interface Attempt {
  url: string;
  method: string;
  hasBody: boolean;
  host: string;
}

function recordedAttempts(fetchMock: ReturnType<typeof vi.fn>): Attempt[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    const u = new URL(String(url));
    return {
      url: String(url),
      method: (init?.method as string) ?? 'GET',
      hasBody: init?.body !== undefined && init?.body !== null,
      host: u.hostname,
    };
  });
}

const metaAttempts = (a: Attempt[]): Attempt[] => a.filter((x) => META_HOST.test(x.host));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VOICE_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02]);
const VOICE_SHA = createHash('sha256').update(VOICE_BYTES).digest('hex');

describe('what the transcription path actually attempts over the network', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The two Meta responses a successful download needs. */
  function stubMetaDownload(): void {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc',
          mime_type: 'audio/ogg',
          sha256: VOICE_SHA,
          file_size: VOICE_BYTES.length,
        })
      )
      .mockResolvedValueOnce(new Response(VOICE_BYTES, { status: 200 }));
  }

  it('control: the run below really did reach Meta (otherwise "no POST" is vacuous)', async () => {
    stubMetaDownload();
    await new WhatsAppMediaClient({ accessToken: 'tok' }).fetchAudio('media-1');

    const attempts = recordedAttempts(fetchMock);
    expect(metaAttempts(attempts).length).toBe(2);
  });

  it('sends only GET to Meta, with no request body, on the whole download path', async () => {
    stubMetaDownload();
    await new WhatsAppMediaClient({ accessToken: 'tok' }).fetchAudio('media-1');

    for (const attempt of metaAttempts(recordedAttempts(fetchMock))) {
      expect(attempt.method, `${attempt.method} to ${attempt.host}`).toBe('GET');
      expect(attempt.hasBody, `body sent to ${attempt.host}`).toBe(false);
    }
  });

  /**
   * The same claim across the WHOLE worker, with the real media client and the
   * real Gladia adapter — the arrangement that actually runs in production,
   * and the one where an outbound call would be introduced if it ever were.
   * Gladia's POST is expected here and is exactly why the assertion is scoped
   * to Meta hosts rather than to the method alone.
   */
  it('runs a complete transcription without one non-GET request to Meta', async () => {
    stubMetaDownload();
    fetchMock
      // Gladia: upload (POST), submit (POST), poll (GET)
      .mockResolvedValueOnce(jsonResponse({ audio_url: 'https://api.gladia.io/u/x.ogg' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1' }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'job-1',
          status: 'done',
          result: {
            transcription: { full_transcript: 'hola', languages: ['es'] },
            metadata: { audio_duration: 3, number_of_distinct_channels: 1, billing_time: 3 },
          },
        })
      );

    const client = createMockClient({
      jobRow: MOCK_JOB_ROW,
      rpc: {
        delete_transcription_job: { data: true },
        record_transcription_submission: { data: null },
        complete_transcription_job: { data: [{ draft_enqueued: true }] },
        record_provider_usage: { data: 'usage-1' },
      },
    });

    const worker = new TranscriptionWorker(
      client,
      (async () => ({
        provider: new GladiaAdapter({ apiKey: 'gladia-key', pollIntervalMs: 250 }),
        media: new WhatsAppMediaClient({ accessToken: 'graph-token' }),
      })) as never,
      { pollIntervalMs: 10, visibilityTimeoutSeconds: 120 }
    );

    await (worker as unknown as { processJob: (j: unknown, s: AbortSignal) => Promise<void> })
      .processJob(MOCK_QUEUE_MESSAGE, new AbortController().signal);

    const attempts = recordedAttempts(fetchMock);

    // Control: the run did what it was supposed to do, so the assertions below
    // are about a real transcription and not about an early failure.
    expect(metaAttempts(attempts).length).toBe(2);
    expect(attempts.some((a) => a.method === 'POST')).toBe(true);

    for (const attempt of metaAttempts(attempts)) {
      expect(attempt.method).toBe('GET');
      expect(attempt.hasBody).toBe(false);
    }
  });

  it('never requests a /messages endpoint on any host', async () => {
    stubMetaDownload();
    await new WhatsAppMediaClient({ accessToken: 'tok' }).fetchAudio('media-1');

    for (const attempt of recordedAttempts(fetchMock)) {
      expect(attempt.url).not.toMatch(/\/messages\b/);
    }
  });
});
