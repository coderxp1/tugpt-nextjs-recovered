import type { SupabaseClient } from '@supabase/supabase-js';
import { GladiaAdapter, ProviderError } from '@tugpt/ai-providers';
import { keyRingFromEnv, readPlatformSecret } from '@tugpt/security';
import { MediaFetchError, WhatsAppMediaClient, DEFAULT_MAX_MEDIA_BYTES } from './whatsapp-media.js';
import type { TranscriptionDepsFactory } from './transcription-worker.js';

/**
 * @file transcription-deps-factory.ts
 * @description Builds the two credentialed clients a transcription attempt
 * needs, from the vault rather than from the environment.
 *
 * ===========================================================================
 * WHY THE VAULT AND NOT ENV VARS
 * ===========================================================================
 *
 * Both credentials here are new, and both arrive after `platform_secrets`
 * exists (migration 20260903000003), so neither inherits the "it was already
 * an env var" argument that keeps `LANGDOCK_API_KEY` where it is. The
 * migration's own reasoning applies directly: an env var cannot be rotated
 * without a deploy, cannot record when it last changed, and cannot be scoped.
 *
 * The ONE thing that must stay in the environment is the key ring
 * (`TUGPT_SECRET_KEY_<ID>`), because a key stored beside its ciphertext is not
 * encryption.
 *
 * ===========================================================================
 * WHY THIS IS CALLED PER JOB
 * ===========================================================================
 *
 * Two selects and two AES-GCM opens per voice note, against a workload of a
 * handful per minute. What it buys: a rotated credential takes effect on the
 * next job rather than the next restart. Rotation that requires a restart is
 * rotation nobody performs during an incident, which is the only time it
 * matters.
 *
 * ===========================================================================
 * WHY THE FAILURES ARE TYPED THE WAY THEY ARE
 * ===========================================================================
 *
 * A missing Gladia key and a missing Meta token are two different operator
 * actions, so they are thrown as two different error types — which is what
 * lets the worker dead-letter them under TRANSCRIPTION_PROVIDER_CONFIG_ERROR
 * and TRANSCRIPTION_MEDIA_AUTH_ERROR respectively. A single "configuration
 * error" would make the dead-letter report say a credential was wrong without
 * saying which, on a path where the two live in different places and are
 * fixed by different people.
 */

/** Where TuGPT's own Gladia key lives in the vault. */
export const GLADIA_SECRET = { provider: 'gladia', secretName: 'api_key' } as const;

/**
 * Where the Meta Graph access token lives.
 *
 * Platform-scoped rather than per-organization: TuGPT's own WhatsApp Business
 * account owns the media, and `whatsapp_connections` carries no token column.
 * When customers bring their own numbers this becomes an
 * `organization_secrets` lookup keyed by the connection — a change to this
 * function, not to the worker.
 */
export const META_SECRET = { provider: 'meta', secretName: 'graph_access_token' } as const;

export interface TranscriptionDepsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly gladiaBaseUrl?: string;
  readonly graphBaseUrl?: string;
  readonly graphVersion?: string;
  readonly maxMediaBytes?: number;
}

/**
 * Reads `TRANSCRIPTION_MAX_MEDIA_BYTES`, falling back to the module default.
 *
 * A malformed value falls back rather than throwing, and says so. The cap
 * exists to bound spend and memory; a worker that refuses to start because
 * somebody typed `8MB` instead of a number has turned a safety limit into an
 * outage.
 */
export function resolveMaxMediaBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.TRANSCRIPTION_MAX_MEDIA_BYTES;
  if (!raw) return DEFAULT_MAX_MEDIA_BYTES;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_MEDIA_BYTES;
  }
  return Math.floor(parsed);
}

export function buildTranscriptionDeps(
  client: SupabaseClient,
  options: TranscriptionDepsOptions = {}
): TranscriptionDepsFactory {
  const env = options.env ?? process.env;

  return async () => {
    const keys = keyRingFromEnv(env);

    if (keys.size === 0) {
      // Distinguished from a missing row because the fix is different: no key
      // ring means the environment file is wrong, not the vault.
      throw new ProviderError(
        'gladia',
        'INVALID_CONFIGURATION',
        undefined,
        'No TUGPT_SECRET_KEY_* in the environment; the vault cannot be opened.'
      );
    }

    let gladiaKey: string;
    try {
      gladiaKey = await readPlatformSecret(client, GLADIA_SECRET.provider, GLADIA_SECRET.secretName, keys);
    } catch (err) {
      throw new ProviderError(
        'gladia',
        'INVALID_CONFIGURATION',
        undefined,
        // The store's message names the identity and never the value.
        err instanceof Error ? err.message : 'could not read the Gladia key'
      );
    }

    let graphToken: string;
    try {
      graphToken = await readPlatformSecret(client, META_SECRET.provider, META_SECRET.secretName, keys);
    } catch (err) {
      throw new MediaFetchError(
        'MEDIA_AUTH_ERROR',
        err instanceof Error ? err.message : 'could not read the Meta Graph token'
      );
    }

    return {
      provider: new GladiaAdapter({
        apiKey: gladiaKey,
        ...(options.gladiaBaseUrl ? { baseUrl: options.gladiaBaseUrl } : {}),
      }),
      media: new WhatsAppMediaClient({
        accessToken: graphToken,
        ...(options.graphBaseUrl ? { baseUrl: options.graphBaseUrl } : {}),
        ...(options.graphVersion ? { graphVersion: options.graphVersion } : {}),
        maxBytes: options.maxMediaBytes ?? resolveMaxMediaBytes(env),
      }),
    };
  };
}
