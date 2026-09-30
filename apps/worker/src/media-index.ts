/**
 * @file media-index.ts
 * @description Dedicated entry point for the media generation worker.
 *
 * Runs on the GPU host as a standalone process (or container). Consumes the `media_jobs` queue.
 *
 * Package scripts:
 *   dev:media  → tsx src/media-index.ts
 *   start:media → node dist/media-index.js
 */

import { createAdminSupabaseClient } from '@tugpt/database';
import { ComfyUIAdapter } from '@tugpt/ai-providers';
import { MediaWorker } from './media-worker.js';

const POLL_INTERVAL_MS = parseInt(process.env.MEDIA_WORKER_POLL_INTERVAL_MS || '5000', 10);
const VISIBILITY_TIMEOUT_SECONDS = parseInt(process.env.MEDIA_WORKER_VISIBILITY_TIMEOUT_SECONDS || '60', 10);

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

  const adapterFactory = () => new ComfyUIAdapter();

  const worker = new MediaWorker(client, adapterFactory, {
    pollIntervalMs: POLL_INTERVAL_MS,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
  });

  const abortController = new AbortController();
  process.on('SIGINT', () => abortController.abort());
  process.on('SIGTERM', () => abortController.abort());

  await worker.run(abortController.signal);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: 'Media worker fatal error', message: (err as Error).message }));
  process.exit(1);
});
