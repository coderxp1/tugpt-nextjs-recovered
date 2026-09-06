import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GladiaAdapter,
  GLADIA_DEFAULT_BASE_URL,
  GLADIA_MIN_POLL_INTERVAL_MS,
} from './gladia';
import { supportsAudioUpload } from './transcription';
import { ProviderError } from './errors';

/**
 * The first test file in @tugpt/ai-providers.
 *
 * Every adapter in this package was previously untested, which is why the
 * assertions below lean on the two things that are cheap to get wrong and
 * expensive to discover: the auth header shape, and the billed quantity.
 */

const KEY = 'gladia-test-key';
const AUDIO = { url: 'https://media.example.com/voice-note.ogg' };

let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A finished job. `channels` drives billing_time the way Gladia defines it. */
function doneJob({
  transcript = 'hola, quiero reservar una mesa',
  audioDuration = 12,
  channels = 1,
  languages = ['es'],
}: {
  transcript?: string | null | number;
  audioDuration?: number;
  channels?: number;
  languages?: unknown;
} = {}) {
  return {
    id: 'job-1',
    status: 'done',
    result: {
      transcription: { full_transcript: transcript, languages },
      metadata: {
        audio_duration: audioDuration,
        number_of_distinct_channels: channels,
        billing_time: audioDuration * channels,
      },
    },
  };
}

function adapter(overrides = {}) {
  return new GladiaAdapter({ apiKey: KEY, pollIntervalMs: GLADIA_MIN_POLL_INTERVAL_MS, ...overrides });
}

/**
 * Assert on the category AND the detail.
 *
 * `ProviderError.message` is the category string by design (errors.ts), so
 * `.toThrow(/some words/)` matches against 'MALFORMED_PROVIDER_RESPONSE' and
 * never against the sentence a reader actually wants — it passes for the wrong
 * reason or fails for a confusing one. The diagnostic lives in
 * `providerDetail`, so that is what gets asserted.
 */
async function expectRejection(
  promise: Promise<unknown>,
  category: string,
  detail?: RegExp
): Promise<ProviderError> {
  try {
    await promise;
    expect.unreachable(`expected a ${category} rejection`);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    const err = e as ProviderError;
    expect(err.category).toBe(category);
    if (detail) expect(err.providerDetail ?? '').toMatch(detail);
    return err;
  }
  throw new Error('unreachable');
}

function expectThrow(fn: () => unknown, category: string, detail?: RegExp): void {
  try {
    fn();
    expect.unreachable(`expected a ${category} throw`);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).category).toBe(category);
    if (detail) expect((e as ProviderError).providerDetail ?? '').toMatch(detail);
  }
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GladiaAdapter — construction', () => {
  it('refuses an empty API key rather than sending an unauthenticated request', () => {
    expect(() => new GladiaAdapter({ apiKey: '' })).toThrow(ProviderError);
    try {
      new GladiaAdapter({ apiKey: '' });
    } catch (e) {
      expect((e as ProviderError).category).toBe('INVALID_CONFIGURATION');
    }
  });

  // The positive control for the two refusals in this block: without it they
  // would both pass against a constructor that rejected everything.
  it('accepts a well-formed configuration', () => {
    expect(() => adapter()).not.toThrow();
    expect(adapter().providerName).toBe('gladia');
  });

  it('refuses a poll interval below the floor instead of clamping it', () => {
    // Clamping would hide the mistake. INVALID_CONFIGURATION is terminal, so a
    // misconfigured deployment fails once with the reason recorded rather than
    // spinning against a rate-limited paid endpoint.
    expectThrow(() => new GladiaAdapter({ apiKey: KEY, pollIntervalMs: 0 }), 'INVALID_CONFIGURATION', /floor/);
    expectThrow(() => new GladiaAdapter({ apiKey: KEY, pollIntervalMs: 10 }), 'INVALID_CONFIGURATION', /floor/);
  });

  it('trims a trailing slash from the base URL so paths do not double up', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1' }, 201));
    await new GladiaAdapter({ apiKey: KEY, baseUrl: 'https://api.gladia.io/' }).submit(AUDIO);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.gladia.io/v2/pre-recorded');
  });
});

describe('GladiaAdapter — submit', () => {
  it('sends x-gladia-key, not an Authorization header', async () => {
    // Gladia does not use Bearer auth. Copying the Langdock adapter's header
    // block is the obvious mistake here, and it fails as a 401 that looks like
    // a bad key rather than a bad header.
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1', result_url: '…' }, 201));
    await adapter().submit(AUDIO);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GLADIA_DEFAULT_BASE_URL}/v2/pre-recorded`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-gladia-key']).toBe(KEY);
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ audio_url: AUDIO.url });
  });

  it('passes a language hint through in the shape Gladia expects', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1' }, 201));
    await adapter().submit(AUDIO, { languageHint: 'es' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      audio_url: AUDIO.url,
      language_config: { languages: ['es'] },
    });
  });

  it('returns the job id', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'job-abc' }, 201));
    await expect(adapter().submit(AUDIO)).resolves.toEqual({ id: 'job-abc', provider: 'gladia' });
  });

  it('refuses a non-http audio URL before making a request', async () => {
    // Gladia fetches this URL server-side, so a bad scheme is a request that
    // asks a third party to open something local. Refused for free, up front.
    await expectRejection(adapter().submit({ url: 'file:///etc/passwd' }), 'INVALID_REQUEST', /not http or https/);
    await expectRejection(adapter().submit({ url: 'not a url' }), 'INVALID_REQUEST', /not a valid URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a submission with no job id as terminal', async () => {
    // Accepting work we cannot name means paying for a result nobody can ever
    // collect.
    fetchMock.mockResolvedValueOnce(json({ result_url: 'https://…' }, 201));
    try {
      await adapter().submit(AUDIO);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('MALFORMED_PROVIDER_RESPONSE');
      expect((e as ProviderError).providerDetail).toMatch(/no job id/);
    }
  });

  it('maps HTTP failures into the shared taxonomy', async () => {
    const cases: Array<[number, string]> = [
      [401, 'HTTP_401'],
      [429, 'HTTP_429'],
      [503, 'HTTP_5XX'],
      [422, 'HTTP_422'],
    ];
    for (const [status, category] of cases) {
      fetchMock.mockResolvedValueOnce(json({ error: { message: 'nope' } }, status));
      try {
        await adapter().submit(AUDIO);
        expect.unreachable(`status ${status} should have thrown`);
      } catch (e) {
        expect((e as ProviderError).category).toBe(category);
        expect((e as ProviderError).httpStatus).toBe(status);
      }
    }
  });

  it('reports a network failure as NETWORK_FAILURE, not as a crash', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    try {
      await adapter().submit(AUDIO);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).category).toBe('NETWORK_FAILURE');
    }
  });

  it('reports an aborted submission as TIMEOUT', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);
    try {
      await adapter().submit(AUDIO);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('TIMEOUT');
    }
  });
});

describe('GladiaAdapter — the billed quantity', () => {
  it('reports billing_time, and keeps audio duration beside it', async () => {
    fetchMock.mockResolvedValueOnce(json(doneJob({ audioDuration: 12, channels: 1 })));
    const r = await adapter().awaitResult('job-1');
    expect(r.usage).toEqual({ billingSeconds: 12, audioSeconds: 12, channels: 1 });
  });

  // THE ASSERTION THIS ADAPTER EXISTS FOR.
  //
  // Gladia bills audio_duration × channels. An implementation that priced
  // "seconds of audio" would understate this stereo file by exactly 100%, and
  // nothing would say so until the invoice.
  it('reports a stereo file as billing twice its wall-clock length', async () => {
    fetchMock.mockResolvedValueOnce(json(doneJob({ audioDuration: 30, channels: 2 })));
    const r = await adapter().awaitResult('job-1');
    expect(r.usage.billingSeconds).toBe(60);
    expect(r.usage.audioSeconds).toBe(30);
    expect(r.usage.billingSeconds).not.toBe(r.usage.audioSeconds);
  });

  it('refuses a finished job with no billing_time rather than substituting duration', async () => {
    const job = doneJob({ audioDuration: 30, channels: 2 }) as {
      result: { metadata: Record<string, unknown> };
    };
    delete job.result.metadata.billing_time;
    fetchMock.mockResolvedValueOnce(json(job));
    try {
      await adapter().awaitResult('job-1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('MALFORMED_PROVIDER_RESPONSE');
      expect((e as ProviderError).providerDetail).toMatch(/refusing to substitute audio_duration/);
    }
  });

  it('refuses a non-numeric or negative billing_time', async () => {
    for (const bad of ['12', -1, null, Number.NaN]) {
      const job = doneJob() as { result: { metadata: Record<string, unknown> } };
      job.result.metadata.billing_time = bad;
      fetchMock.mockResolvedValueOnce(json(job));
      await expect(adapter().awaitResult('job-1')).rejects.toThrow(ProviderError);
    }
  });

  it('reports unreported duration and channels as zero without touching the billed figure', async () => {
    // These two are metadata and are never priced, so a zero here cannot cost
    // anyone money — unlike a zero in billingSeconds, which is why that one is
    // refused above instead of defaulted.
    fetchMock.mockResolvedValueOnce(
      json({ id: 'job-1', status: 'done', result: { metadata: { billing_time: 41 } } })
    );
    const r = await adapter().awaitResult('job-1');
    expect(r.usage).toEqual({ billingSeconds: 41, audioSeconds: 0, channels: 0 });
  });
});

describe('GladiaAdapter — the transcript', () => {
  it('returns the transcript and the detected language', async () => {
    fetchMock.mockResolvedValueOnce(json(doneJob()));
    const r = await adapter().awaitResult('job-1');
    expect(r.text).toBe('hola, quiero reservar una mesa');
    expect(r.languageCode).toBe('es');
    expect(r.id).toBe('job-1');
    expect(r.provider).toBe('gladia');
  });

  it('reports no model rather than inventing one', async () => {
    // A placeholder string would land in provider_usage_events.model looking
    // exactly like a real model name.
    fetchMock.mockResolvedValueOnce(json(doneJob()));
    expect((await adapter().awaitResult('job-1')).model).toBeNull();
  });

  it('returns an empty transcript as a successful, billed result', async () => {
    // A silent voice note transcribes to nothing and is billed anyway.
    // Throwing here would lose the billing row for work really performed; the
    // decision about what to do with an empty transcript belongs beside the
    // existing `body_text IS NOT NULL` gate where drafts are enqueued.
    fetchMock.mockResolvedValueOnce(json(doneJob({ transcript: '', audioDuration: 3 })));
    const r = await adapter().awaitResult('job-1');
    expect(r.text).toBe('');
    expect(r.usage.billingSeconds).toBe(3);
  });

  it('treats a missing transcript field as empty, but a non-string one as malformed', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ id: 'job-1', status: 'done', result: { metadata: { billing_time: 5 } } })
    );
    expect((await adapter().awaitResult('job-1')).text).toBe('');

    fetchMock.mockResolvedValueOnce(json(doneJob({ transcript: 42 })));
    await expectRejection(adapter().awaitResult('job-1'), 'MALFORMED_PROVIDER_RESPONSE', /non-string transcript/);
  });

  it('omits languageCode when the provider reports none', async () => {
    fetchMock.mockResolvedValueOnce(json(doneJob({ languages: [] })));
    expect((await adapter().awaitResult('job-1')).languageCode).toBeUndefined();
  });
});

describe('GladiaAdapter — polling', () => {
  it('polls until the job is done', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ id: 'job-1', status: 'queued' }))
      .mockResolvedValueOnce(json({ id: 'job-1', status: 'processing' }))
      .mockResolvedValueOnce(json(doneJob()));

    const r = await adapter().awaitResult('job-1');
    expect(r.text).toBe('hola, quiero reservar una mesa');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(`${GLADIA_DEFAULT_BASE_URL}/v2/pre-recorded/job-1`);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('encodes the job id into the path', async () => {
    fetchMock.mockResolvedValueOnce(json(doneJob()));
    await adapter().awaitResult('a/b?c');
    expect(fetchMock.mock.calls[0][0]).toBe(`${GLADIA_DEFAULT_BASE_URL}/v2/pre-recorded/a%2Fb%3Fc`);
  });

  it('times out with a detail that names the id and says not to resubmit', async () => {
    // The job is still running and still billed. A caller that reads this as
    // "it failed" and resubmits pays twice for one voice note.
    //
    // mockImplementation, not mockResolvedValue: a Response body can only be
    // read once, so handing the same instance to every poll makes the second
    // read fail as MALFORMED_PROVIDER_RESPONSE. That turns any assertion about
    // repeated polling into an assertion about a reused body.
    fetchMock.mockImplementation(async () => json({ id: 'job-1', status: 'processing' }));
    const err = await expectRejection(
      adapter().awaitResult('job-1', { maxWaitMs: 100 }),
      'TIMEOUT',
      /do not resubmit/
    );
    expect(err.providerDetail).toContain('job-1');

    // The ceiling bounds the wait, not the wait plus one more interval: with a
    // 250ms interval and a 100ms budget it must give up without ever sleeping.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates a caller-supplied poll interval, not just the configured one', async () => {
    // The floor is a property of every poll loop, so overriding it per call
    // must not route around it.
    fetchMock.mockImplementation(async () => json({ id: 'job-1', status: 'queued' }));
    await expectRejection(
      adapter().awaitResult('job-1', { pollIntervalMs: 0 }),
      'INVALID_CONFIGURATION',
      /floor/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops polling when the signal aborts', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => json({ id: 'job-1', status: 'queued' }));
    const pending = adapter().awaitResult('job-1', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(ProviderError);
  });

  it('distinguishes a failed job from a failed poll request', async () => {
    // "The answer is: it failed" and "I could not ask" are different facts, and
    // the dead-letter record has to be able to tell them apart.
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1', status: 'error', error_code: 500 }));
    try {
      await adapter().awaitResult('job-1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('HTTP_5XX');
      expect((e as ProviderError).providerDetail).toMatch(/^job failed:/);
    }

    fetchMock.mockResolvedValueOnce(json({ error: { message: 'gateway' } }, 500));
    try {
      await adapter().awaitResult('job-1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('HTTP_5XX');
      expect((e as ProviderError).providerDetail ?? '').not.toMatch(/^job failed:/);
    }
  });

  it('maps a terminal job error code to a terminal category', async () => {
    // 401 is FALLBACK_PROHIBITED in the shared matrix, so a bad key stops
    // immediately instead of retrying against a provider that will keep
    // refusing.
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1', status: 'error', error_code: 401 }));
    try {
      await adapter().awaitResult('job-1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('HTTP_401');
    }
  });

  it('falls back to UNKNOWN_FAILURE for an unusable error code', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1', status: 'error' }));
    try {
      await adapter().awaitResult('job-1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('UNKNOWN_FAILURE');
      expect((e as ProviderError).providerDetail).toMatch(/unreported/);
    }
  });

  it('refuses an unrecognised status rather than polling forever', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'job-1', status: 'paused' }));
    try {
      await adapter().awaitResult('job-1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ProviderError).category).toBe('MALFORMED_PROVIDER_RESPONSE');
      expect((e as ProviderError).providerDetail).toMatch(/paused/);
    }
  });

  it('refuses a non-JSON poll body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 200 }));
    await expectRejection(adapter().awaitResult('job-1'), 'MALFORMED_PROVIDER_RESPONSE', /not JSON/);
  });
});

describe('GladiaAdapter — transcribe', () => {
  it('submits, then polls, and reports total latency', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ id: 'job-9' }, 201))
      .mockResolvedValueOnce(json(doneJob()));

    const r = await adapter().transcribe(AUDIO);
    expect(r.id).toBe('job-9');
    expect(r.text).toBe('hola, quiero reservar una mesa');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
  });

  it('calls onSubmitted with the id before it starts waiting', async () => {
    // Everything after submission is billed work. A caller that cannot name
    // the job later has no recovery except paying again, so the id has to be
    // persistable at exactly this point and not one line later.
    const order: string[] = [];
    fetchMock
      .mockImplementationOnce(async () => {
        order.push('submit');
        return json({ id: 'job-9' }, 201);
      })
      .mockImplementationOnce(async () => {
        order.push('poll');
        return json(doneJob());
      });

    const seen: string[] = [];
    await adapter().transcribe(AUDIO, {
      onSubmitted: (id) => {
        order.push('onSubmitted');
        seen.push(id);
      },
    });

    expect(seen).toEqual(['job-9']);
    expect(order).toEqual(['submit', 'onSubmitted', 'poll']);
  });

  it('awaits an async onSubmitted before polling', async () => {
    const order: string[] = [];
    fetchMock
      .mockResolvedValueOnce(json({ id: 'job-9' }, 201))
      .mockImplementationOnce(async () => {
        order.push('poll');
        return json(doneJob());
      });

    await adapter().transcribe(AUDIO, {
      onSubmitted: async () => {
        await Promise.resolve();
        order.push('persisted');
      },
    });
    expect(order).toEqual(['persisted', 'poll']);
  });

  it('propagates an onSubmitted failure instead of waiting anyway', async () => {
    // If the id could not be recorded, waiting for a result nobody can resume
    // is the worse outcome — and it is worse silently.
    fetchMock.mockResolvedValueOnce(json({ id: 'job-9' }, 201));
    await expect(
      adapter().transcribe(AUDIO, {
        onSubmitted: () => {
          throw new Error('database unavailable');
        },
      })
    ).rejects.toThrow('database unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never polls when submission fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'bad key' } }, 401));
    await expect(adapter().transcribe(AUDIO)).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GladiaAdapter — uploadAudio', () => {
  const BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02, 0x03]);
  const UPLOAD = { bytes: BYTES, filename: 'voice-note.ogg', contentType: 'audio/ogg' };

  it('posts multipart to /v2/upload and returns the URL Gladia can fetch', async () => {
    fetchMock.mockResolvedValueOnce(json({ audio_url: 'https://gladia.example/u/abc.ogg' }, 200));

    const source = await adapter().uploadAudio(UPLOAD);

    expect(source).toEqual({
      url: 'https://gladia.example/u/abc.ogg',
      contentType: 'audio/ogg',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GLADIA_DEFAULT_BASE_URL}/v2/upload`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  /**
   * The one that is easy to get wrong and hard to diagnose. `fetch` generates
   * the multipart Content-Type together with the boundary; a hand-set header
   * replaces it with one that has no boundary, and the server then reads the
   * whole body as a single unparseable blob and answers 4xx as though the file
   * were bad.
   */
  it('sets no Content-Type, leaving fetch to generate the multipart boundary', async () => {
    fetchMock.mockResolvedValueOnce(json({ audio_url: 'https://gladia.example/u/abc.ogg' }));
    await adapter().uploadAudio(UPLOAD);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-gladia-key']).toBe(KEY);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('sends the audio under the field name and filename Gladia expects', async () => {
    fetchMock.mockResolvedValueOnce(json({ audio_url: 'https://gladia.example/u/abc.ogg' }));
    await adapter().uploadAudio(UPLOAD);

    const form = fetchMock.mock.calls[0][1].body as FormData;
    const part = form.get('audio') as File;
    expect(part).toBeInstanceOf(Blob);
    expect(part.name).toBe('voice-note.ogg');
    expect(part.type).toBe('audio/ogg');
    expect(await part.arrayBuffer()).toEqual(BYTES.buffer.slice(0, BYTES.length));
  });

  /**
   * A Blob built from a view onto a pooled Node Buffer carries the whole
   * underlying ArrayBuffer, not the view's window — so a 7-byte voice note can
   * arrive as 8 KiB of whatever else that pool held. The adapter copies; this
   * asserts the copy, by uploading a view whose backing buffer is larger than
   * the view.
   */
  it('uploads exactly the bytes it was given, not the buffer behind them', async () => {
    const pool = new Uint8Array(64).fill(0xff);
    const view = pool.subarray(8, 15);
    view.set(BYTES);

    fetchMock.mockResolvedValueOnce(json({ audio_url: 'https://gladia.example/u/abc.ogg' }));
    await adapter().uploadAudio({ ...UPLOAD, bytes: view });

    const part = (fetchMock.mock.calls[0][1].body as FormData).get('audio') as File;
    expect(part.size).toBe(7);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(BYTES);
  });

  it('refuses an empty upload rather than producing a plausible silent transcript', async () => {
    await expectRejection(
      adapter().uploadAudio({ ...UPLOAD, bytes: new Uint8Array(0) }),
      'INVALID_REQUEST',
      /empty/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an HTTP failure through the shared taxonomy, detail and all', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'audio file is too large' } }, 400));
    await expectRejection(adapter().uploadAudio(UPLOAD), 'HTTP_400', /too large/);
  });

  // Status-specific categories, not a generic HTTP bucket. The worker's retry
  // budget is spent on the difference: a 503 during upload costs nothing and
  // deserves a retry, a 401 will fail identically three times. That decision
  // lives in the worker (isTransientTranscriptionCategory); what the adapter
  // owes it is a category precise enough to make it.
  it('classifies an upload 401 distinctly from a 5xx, with the status kept', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'bad key' } }, 401));
    const err = await expectRejection(adapter().uploadAudio(UPLOAD), 'HTTP_401');
    expect(err.httpStatus).toBe(401);
  });

  it('classifies an upload 503 as HTTP_5XX', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'down' } }, 503));
    const err = await expectRejection(adapter().uploadAudio(UPLOAD), 'HTTP_5XX');
    expect(err.httpStatus).toBe(503);
  });

  it('rejects a 200 that carries no audio_url instead of returning undefined', async () => {
    fetchMock.mockResolvedValueOnce(json({ audio_metadata: { audio_duration: 3 } }));
    await expectRejection(
      adapter().uploadAudio(UPLOAD),
      'MALFORMED_PROVIDER_RESPONSE',
      /no audio_url/
    );
  });

  it('rejects a non-JSON upload response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 200 }));
    await expectRejection(adapter().uploadAudio(UPLOAD), 'MALFORMED_PROVIDER_RESPONSE', /not JSON/);
  });

  it('surfaces a network failure as NETWORK_FAILURE', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expectRejection(adapter().uploadAudio(UPLOAD), 'NETWORK_FAILURE');
  });

  it('passes the abort signal through', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(json({ audio_url: 'https://gladia.example/u/abc.ogg' }));
    await adapter().uploadAudio(UPLOAD, { signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  /**
   * The composition the worker actually performs. Asserted end to end because
   * the value that has to survive the join — Gladia's own audio_url — is
   * produced by one call and consumed by the next, and a mistake there is a
   * submission against a URL nobody uploaded to.
   */
  it('composes with submit: the uploaded URL is what gets transcribed', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ audio_url: 'https://gladia.example/u/xyz.ogg' }))
      .mockResolvedValueOnce(json({ id: 'job-up' }, 201))
      .mockResolvedValueOnce(json(doneJob()));

    const a = adapter();
    const source = await a.uploadAudio(UPLOAD);
    const result = await a.transcribe(source);

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).audio_url).toBe(
      'https://gladia.example/u/xyz.ogg'
    );
    expect(result.text).toBe('hola, quiero reservar una mesa');
  });
});

describe('supportsAudioUpload', () => {
  it('narrows the Gladia adapter, which implements both contracts', () => {
    expect(supportsAudioUpload(adapter())).toBe(true);
  });

  /**
   * The negative control. Without it this guard would pass for a function that
   * returned true unconditionally — which is exactly the shape of the bug it
   * exists to prevent, since a caller uses it to decide whether to upload or
   * to hand over a URL the provider cannot fetch.
   */
  it('rejects a transcription provider that cannot take an upload', () => {
    const urlOnly = {
      providerName: 'url-only',
      submit: async () => ({ id: 'x', provider: 'url-only' }),
      awaitResult: async () => {
        throw new Error('not used');
      },
      transcribe: async () => {
        throw new Error('not used');
      },
    };
    expect(supportsAudioUpload(urlOnly as never)).toBe(false);
  });
});
