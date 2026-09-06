/**
 * @file transcription-index.ts
 * @description Entry point for the transcription worker.
 *
 * A THIRD process, not a third loop inside an existing one. The standing rule
 * in docker-compose.yml is one consumer per PGMQ queue, and the amendment that
 * kept the WhatsApp and draft workers separate applies unchanged here: a
 * transcription attempt can hold a slot for five minutes waiting on Gladia,
 * and sharing a process with the draft loop would stall draft generation
 * behind one voice note.
 *
 * STARTS WITH NO PROVIDER CREDENTIALS. Only the Supabase URL, the service-role
 * key, and the key ring are required at boot; the Gladia key and the Meta
 * Graph token are read from `platform_secrets` when a job is actually claimed.
 * That is what lets this worker run safely while `voice_transcription` is off
 * everywhere, which is its state on every organization today.
 */

import { createAdminSupabaseClient } from '@tugpt/database';
import { buildTranscriptionDeps } from './transcription-deps-factory.js';
import { TranscriptionWorker } from './transcription-worker.js';
import { TRANSCRIPTION_DEFAULT_VISIBILITY_SECONDS } from './transcription-queue-adapter.js';

const POLL_INTERVAL_MS = parseInt(process.env.TRANSCRIPTION_WORKER_POLL_INTERVAL_MS || '5000', 10);
const VISIBILITY_TIMEOUT_SECONDS = parseInt(
  process.env.TRANSCRIPTION_WORKER_VISIBILITY_TIMEOUT_SECONDS ||
    String(TRANSCRIPTION_DEFAULT_VISIBILITY_SECONDS),
  10
);

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({
      error: 'Missing required environment variables',
      required: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    }));
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as any;

  const worker = new TranscriptionWorker(client, buildTranscriptionDeps(client), {
    pollIntervalMs: POLL_INTERVAL_MS,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
  });

  const abortController = new AbortController();
  process.on('SIGINT', () => abortController.abort());
  process.on('SIGTERM', () => abortController.abort());

  await worker.run(abortController.signal);
}

main().catch((err) => {
  console.error(JSON.stringify({
    error: 'Transcription worker fatal error',
    message: (err as Error).message,
  }));
  process.exit(1);
});
