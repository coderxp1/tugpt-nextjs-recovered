import { createHash } from 'node:crypto';

/**
 * @file whatsapp-media.ts
 * @description Downloads inbound WhatsApp audio from Meta's Graph API.
 *
 * ===========================================================================
 * SCOPE, AND WHY IT IS NARROW
 * ===========================================================================
 *
 * Approved on 2026-09-04, in these words: the transcription worker may call
 * Meta's Graph media endpoint to download inbound audio — read-only,
 * download-only, using existing credentials. **This does not open outbound
 * messaging.** The `whatsapp_integration` flag still gates every send, and
 * nothing in this file can send anything: it issues GET requests to two
 * endpoints and has no code path that POSTs.
 *
 * `outbound-gate.test.ts` is the mechanical version of that sentence.
 *
 * ===========================================================================
 * THE TWO-STEP FLOW, AND WHY THE FIRST STEP IS NOT SKIPPABLE
 * ===========================================================================
 *
 *   GET /<version>/<media-id>   -> { url, mime_type, sha256, file_size }
 *   GET <url>                   -> the bytes
 *
 * Both carry the access token. The first response is what makes the download
 * safe rather than merely possible:
 *
 *   * `file_size` is the ONLY chance to refuse a file before paying to move
 *     it. Gladia bills per second of audio, so a two-hour recording is a real
 *     invoice line, and the cheapest place to decline it is before the
 *     transfer.
 *
 *   * `sha256` is what makes the bytes verifiable. Without it a truncated
 *     transfer produces a shorter file that decodes to a shorter transcript —
 *     plausible, wrong, and invisible to the reviewer who approves a draft
 *     written from it.
 *
 * `url` is short-lived (Meta expires it in minutes) and is a bearer-ish handle
 * to customer audio. It is never logged, never persisted, and never returned
 * to a caller.
 *
 * ===========================================================================
 * WHY THE SIZE IS CHECKED TWICE
 * ===========================================================================
 *
 * `file_size` is a number a third party told us. A cap enforced only against
 * it is a cap that disappears the day the field is absent, wrong, or
 * understated — and the consequence is unbounded memory in a worker process,
 * because the whole file is buffered to be uploaded to Gladia.
 *
 * So the ceiling is enforced twice: once against the declared size, cheaply,
 * before any transfer; and once against the bytes actually arriving, which is
 * the one that cannot be lied to. The second check reads the body in chunks
 * and aborts the moment the total passes the ceiling, rather than downloading
 * everything and measuring afterwards.
 *
 * ===========================================================================
 * WHY THE HOST IS CHECKED
 * ===========================================================================
 *
 * Step one's response tells this code where to send the access token in step
 * two. That response comes from Meta over TLS, so it is trusted — but "the
 * server tells us where to send our credential" is a shape worth constraining
 * on principle, and the constraint costs one comparison. The token goes to
 * Meta's own hosts over HTTPS or it does not go.
 */

/** Meta's own ceiling for audio is 16 MiB; this is the ceiling we choose. */
export const DEFAULT_MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** Graph API version. Pinned: an unpinned version changes response shapes under us. */
export const DEFAULT_GRAPH_VERSION = 'v21.0';

export const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';

/**
 * Hosts the access token may be sent to.
 *
 * Suffix matched against the full hostname with a leading dot, so
 * `evil-fbcdn.net` does not match `.fbcdn.net` — the classic mistake in a
 * check of this kind is `endsWith('fbcdn.net')`, which it does match.
 */
const ALLOWED_HOST_SUFFIXES = ['.facebook.com', '.fbcdn.net', '.fbsbx.com', '.whatsapp.net'];

export type MediaErrorCode =
  /** Meta will not serve this id: gone, expired, or never ours. Terminal. */
  | 'MEDIA_UNAVAILABLE'
  /** Bigger than the ceiling. Terminal — a recording does not shrink. */
  | 'MEDIA_TOO_LARGE'
  /** Our token is bad or lacks the permission. Terminal, and an operator page. */
  | 'MEDIA_AUTH_ERROR'
  /** 429 or 5xx: worth another attempt. */
  | 'MEDIA_TRANSIENT'
  /** A response that did not have the shape the API documents. Terminal. */
  | 'MEDIA_MALFORMED'
  /** Downloaded bytes did not match the digest Meta reported. Terminal. */
  | 'MEDIA_INTEGRITY';

export class MediaFetchError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    /** Sanitized. Never a URL, never customer content. */
    readonly detail?: string,
    readonly httpStatus?: number
  ) {
    super(code);
    this.name = 'MediaFetchError';
  }
}

/** What step one reports. `url` is short-lived and never leaves this module. */
interface MediaDescriptor {
  readonly url: string;
  readonly mimeType: string;
  readonly sha256?: string;
  readonly fileSizeBytes?: number;
}

export interface DownloadedMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** Computed from the bytes, not copied from the metadata. */
  readonly sha256: string;
  readonly declaredSizeBytes?: number;
}

export interface WhatsAppMediaClientConfig {
  /** Graph access token. Read from `platform_secrets`, never from an env var. */
  readonly accessToken: string;
  readonly graphVersion?: string;
  readonly baseUrl?: string;
  readonly maxBytes?: number;
}

function isAllowedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => lower === suffix.slice(1) || lower.endsWith(suffix)
  );
}

/** Turn an HTTP status into the taxonomy above. */
function classify(status: number): MediaErrorCode {
  if (status === 401 || status === 403) return 'MEDIA_AUTH_ERROR';
  if (status === 404 || status === 410) return 'MEDIA_UNAVAILABLE';
  if (status === 429 || status >= 500) return 'MEDIA_TRANSIENT';
  return 'MEDIA_UNAVAILABLE';
}

export class WhatsAppMediaClient {
  private readonly accessToken: string;
  private readonly graphVersion: string;
  private readonly baseUrl: string;
  readonly maxBytes: number;

  constructor(config: WhatsAppMediaClientConfig) {
    if (!config.accessToken) {
      // The same refusal GladiaAdapter makes for an empty key: an
      // unauthenticated request to Graph returns a 400 that reads like a bad
      // media id, and the real cause is a credential that was never loaded.
      throw new MediaFetchError(
        'MEDIA_AUTH_ERROR',
        'Graph access token is empty. It is read from platform_secrets, not the environment.'
      );
    }
    this.accessToken = config.accessToken;
    this.graphVersion = config.graphVersion || DEFAULT_GRAPH_VERSION;
    this.baseUrl = (config.baseUrl || DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, '');
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      // Meta rejects some CDN requests that arrive without one. Documented
      // behaviour, and the failure without it is a 400 that looks like a bad
      // media id.
      'User-Agent': 'TuGPT-Worker/1.0',
    };
  }

  /**
   * Step one: ask Meta what the media is and where it currently lives.
   *
   * Private because the URL it returns is the thing this module exists to
   * contain. Returning it to a caller would put a short-lived handle to
   * customer audio into a variable somebody logs.
   */
  private async describe(mediaId: string, signal?: AbortSignal): Promise<MediaDescriptor> {
    const endpoint = `${this.baseUrl}/${this.graphVersion}/${encodeURIComponent(mediaId)}`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      });
    } catch {
      // An abort lands here too and is also transient: the worker aborts on
      // shutdown, and the job should be redelivered rather than dead-lettered
      // because a deploy happened. No branch distinguishes them, because there
      // is no different action to take — and a branch whose arms are equal is
      // a guard that reads as protection and provides none.
      throw new MediaFetchError('MEDIA_TRANSIENT', 'network failure contacting the Graph API');
    }

    if (!response.ok) {
      throw new MediaFetchError(
        classify(response.status),
        `Graph metadata request returned ${response.status}`,
        response.status
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new MediaFetchError('MEDIA_MALFORMED', 'Graph metadata response was not JSON');
    }

    const url = body.url;
    if (typeof url !== 'string' || url.length === 0) {
      throw new MediaFetchError('MEDIA_MALFORMED', 'Graph metadata carried no url');
    }

    const mimeType = typeof body.mime_type === 'string' ? body.mime_type : 'application/octet-stream';
    const sha256 = typeof body.sha256 === 'string' && body.sha256.length > 0 ? body.sha256 : undefined;

    // Graph reports file_size as a number in current versions and has
    // reported it as a numeric string in older ones. Accepting both is one
    // line; rejecting the string form would disable the pre-download size
    // check silently, which is the check that costs money to lose.
    const rawSize = body.file_size;
    let fileSizeBytes: number | undefined;
    if (typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize >= 0) {
      fileSizeBytes = rawSize;
    } else if (typeof rawSize === 'string' && /^\d+$/.test(rawSize)) {
      fileSizeBytes = Number(rawSize);
    }

    return { url, mimeType, sha256, fileSizeBytes };
  }

  /**
   * Step two: fetch the bytes, refusing to buffer more than the ceiling.
   *
   * Read through the stream rather than `arrayBuffer()`. `arrayBuffer()`
   * buffers the whole response before this code sees a single byte, so a cap
   * applied to its result is a cap applied after the memory was already
   * allocated — which is precisely the failure the cap exists to prevent.
   */
  private async downloadBytes(
    descriptor: MediaDescriptor,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    let parsed: URL;
    try {
      parsed = new URL(descriptor.url);
    } catch {
      throw new MediaFetchError('MEDIA_MALFORMED', 'Graph metadata carried an unparseable url');
    }
    if (parsed.protocol !== 'https:') {
      throw new MediaFetchError('MEDIA_MALFORMED', 'media url is not https');
    }
    if (!isAllowedHost(parsed.hostname)) {
      // Deliberately does not name the host. It came from a response, and an
      // error message is a log line.
      throw new MediaFetchError('MEDIA_MALFORMED', 'media url host is not a Meta host');
    }

    let response: Response;
    try {
      response = await fetch(descriptor.url, {
        method: 'GET',
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new MediaFetchError('MEDIA_TRANSIENT', 'network failure downloading media');
    }

    if (!response.ok) {
      throw new MediaFetchError(
        classify(response.status),
        `media download returned ${response.status}`,
        response.status
      );
    }

    // A Content-Length past the ceiling is a free refusal, before a byte is
    // read. It is not trusted as a limit — that is what the loop below is for.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new MediaFetchError(
        'MEDIA_TOO_LARGE',
        `media declares ${declared} bytes, over the ${this.maxBytes}-byte ceiling`
      );
    }

    if (!response.body) {
      throw new MediaFetchError('MEDIA_MALFORMED', 'media response had no body');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        total += value.byteLength;
        if (total > this.maxBytes) {
          // Cancel rather than drain: the point is to stop paying to move it.
          await reader.cancel().catch(() => undefined);
          throw new MediaFetchError(
            'MEDIA_TOO_LARGE',
            `media exceeded the ${this.maxBytes}-byte ceiling mid-transfer`
          );
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof MediaFetchError) throw err;
      throw new MediaFetchError('MEDIA_TRANSIENT', 'media transfer was interrupted');
    }

    if (total === 0) {
      throw new MediaFetchError('MEDIA_MALFORMED', 'media download produced no bytes');
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  /**
   * Describe, refuse if too large, download, verify.
   *
   * The whole reason this is one method rather than three exported ones: the
   * order is the safety property. Downloading before checking the size, or
   * returning bytes before checking the digest, are both things a caller could
   * do accidentally with a more granular API, and both are silent.
   */
  async fetchAudio(mediaId: string, signal?: AbortSignal): Promise<DownloadedMedia> {
    const descriptor = await this.describe(mediaId, signal);

    if (descriptor.fileSizeBytes !== undefined && descriptor.fileSizeBytes > this.maxBytes) {
      throw new MediaFetchError(
        'MEDIA_TOO_LARGE',
        `media is ${descriptor.fileSizeBytes} bytes, over the ${this.maxBytes}-byte ceiling`
      );
    }

    const bytes = await this.downloadBytes(descriptor, signal);
    const digest = createHash('sha256').update(bytes).digest('hex');

    // Compared only when Meta reported one. Treating an absent digest as a
    // failure would refuse every file on a Graph version that stops sending
    // it; treating a MISMATCH as anything but terminal would let a truncated
    // transfer become a shorter, plausible, wrong transcript.
    if (descriptor.sha256 && descriptor.sha256.toLowerCase() !== digest) {
      throw new MediaFetchError(
        'MEDIA_INTEGRITY',
        'downloaded bytes did not match the digest Meta reported'
      );
    }

    return {
      bytes,
      mimeType: descriptor.mimeType,
      sha256: digest,
      ...(descriptor.fileSizeBytes !== undefined
        ? { declaredSizeBytes: descriptor.fileSizeBytes }
        : {}),
    };
  }
}
