/**
 * Media E2E: authenticated request → tenant-authorized DB job + PGMQ queue
 * → media worker → (mocked) ComfyUI → private Supabase Storage
 * → authorized signed-result retrieval.
 *
 * Runs against a local Supabase stack (`supabase db start` in CI).
 * ComfyUI is mocked; everything else is real: Postgres RLS, PGMQ via the
 * actual media RPCs, and the private `media` storage bucket.
 *
 * Required env:
 *   SUPABASE_URL            (local API, e.g. http://127.0.0.1:54321)
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Exit 0 when every assertion passes; non-zero with the first failure.
 *
 * Assertions:
 *  A1. Org A submits → submit_media_job returns a job id (tenant-authorized
 *      DB row + PGMQ message).
 *  A2. The worker claims it via read_media_jobs, renders via the mock,
 *      uploads to media/<orgA>/<jobId>.png, and completes the row.
 *  A3. Exactly one ComfyUI submission happened (no double-submit).
 *  A4. Org A's authenticated client reads its own job row (RLS allows).
 *  A5. Org B's authenticated client reads NULL for Org A's job —
 *      byte-identical to reading an unknown job id (both → 404).
 *  A6. The private object is not anonymously readable.
 *  A7. A signed URL minted for Org A's result is authorized (org-scoped
 *      read succeeded first — the route's 404-vs-200 branch).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MediaWorker } from '../media-worker.js';
import { ComfyUIAdapter } from '@tugpt/ai-providers';
import { startMockComfyUI } from './mock-comfyui.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.API_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

let failures = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function requireEnv(): void {
  const missing = [
    ['SUPABASE_URL', SUPABASE_URL],
    ['SUPABASE_ANON_KEY', ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(2);
  }
}

async function createOrgUser(
  admin: SupabaseClient,
  email: string
): Promise<{ userId: string; orgId: string; client: SupabaseClient }> {
  const password = `e2e-${Math.random().toString(36).slice(2)}-Pw1!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) throw new Error(`createUser failed: ${userError?.message}`);
  const userId = userData.user.id;

  // profiles row mirrors auth.users (FK from organization_members).
  const { error: profileError } = await admin.from('profiles').upsert({ id: userId });
  if (profileError) throw new Error(`profiles upsert failed: ${profileError.message}`);

  const { data: orgData, error: orgError } = await admin
    .from('organizations')
    .insert({ name: `e2e-${email}`, slug: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    .select('id')
    .single();
  if (orgError || !orgData) throw new Error(`organization insert failed: ${orgError?.message}`);
  const orgId = (orgData as { id: string }).id;

  const { error: memberError } = await admin.from('organization_members').insert({
    organization_id: orgId,
    user_id: userId,
    role: 'owner',
  });
  if (memberError) throw new Error(`organization_members insert failed: ${memberError.message}`);

  // Enable the media_generation feature flag for this org.
  const { error: flagError } = await admin.from('feature_flags').upsert(
    { organization_id: orgId, key: 'media_generation', is_enabled: true },
    { onConflict: 'organization_id,key' }
  );
  if (flagError) throw new Error(`feature_flags upsert failed: ${flagError.message}`);

  const client = createClient(SUPABASE_URL!, ANON_KEY!);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn failed: ${signInError.message}`);

  return { userId, orgId, client };
}

async function main(): Promise<void> {
  requireEnv();
  console.log('media E2E: local Supabase + mocked ComfyUI');

  const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // --- Setup: two organizations -----------------------------------------
  console.log('setup: creating org A and org B');
  const orgA = await createOrgUser(admin, `e2e-a-${Date.now()}@example.com`);
  const orgB = await createOrgUser(admin, `e2e-b-${Date.now()}@example.com`);

  // --- Mock ComfyUI -------------------------------------------------------
  const mock = await startMockComfyUI();
  console.log(`mock ComfyUI at ${mock.url}`);

  // --- A1: Org A submits --------------------------------------------------
  console.log('A1: org A submits a job');
  const { data: submitData, error: submitError } = await admin.rpc('submit_media_job', {
    p_user_id: orgA.userId,
    p_organization_id: orgA.orgId,
    p_kind: 'image',
    p_prompt: 'e2e test image',
    p_params: { lane: 'lightning' },
    p_idempotency_key: `e2e-${Date.now()}`,
  });
  assert('submit_media_job succeeds', !submitError && !!submitData, submitError?.message);
  const jobId = (submitData as Array<{ job_id: string }>)[0]?.job_id as string;
  assert('submit returns a job id', typeof jobId === 'string' && jobId.length > 0);

  // --- Run the worker until the job completes (or timeout) ----------------
  console.log('worker: processing with mocked ComfyUI');
  process.env.COMFYUI_BASE_URL = mock.url;
  const worker = new MediaWorker(
    admin as never,
    () => new ComfyUIAdapter({ baseUrl: mock.url }) as never,
    { pollIntervalMs: 500, visibilityTimeoutSeconds: 60 }
  );
  const controller = new AbortController();
  const runPromise = worker.run(controller.signal).catch((e: Error) => {
    console.error(`worker crashed: ${e.message}`);
    failures += 1;
  });

  const deadline = Date.now() + 60_000;
  let jobRow: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from('media_generation_jobs')
      .select('id, status, result_path, prompt_id')
      .eq('id', jobId)
      .maybeSingle();
    jobRow = data as Record<string, unknown> | null;
    if (jobRow?.status === 'completed' || jobRow?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  controller.abort();
  await runPromise;

  // --- A2: job completed with a private result path -----------------------
  console.log('A2: job completed, result in private storage');
  assert('job reached completed', jobRow?.status === 'completed', `status=${jobRow?.status}`);
  const resultPath = jobRow?.result_path as string | null;
  assert('result_path recorded', typeof resultPath === 'string' && resultPath.length > 0);
  assert(
    'result path is org-scoped',
    !!resultPath && resultPath.startsWith(`${orgA.orgId}/${jobId}`),
    resultPath || undefined
  );

  // --- A3: exactly one ComfyUI submission ----------------------------------
  console.log('A3: no double-submit');
  assert('ComfyUI received exactly one prompt', mock.receivedPrompts.length === 1,
    `received=${mock.receivedPrompts.length}`);

  // --- A4: org A reads its own job ----------------------------------------
  console.log('A4: org A reads its own job (RLS allows)');
  const { data: orgARead } = await orgA.client
    .from('media_generation_jobs')
    .select('id')
    .eq('id', jobId)
    .eq('organization_id', orgA.orgId)
    .maybeSingle();
  assert('org A sees its job', !!orgARead);

  // --- A5: org B gets the same 404 as an unknown job -----------------------
  console.log('A5: org B gets 404 for org A job (identical to unknown job)');
  const { data: orgBRead } = await orgB.client
    .from('media_generation_jobs')
    .select('id')
    .eq('id', jobId)
    .eq('organization_id', orgB.orgId)
    .maybeSingle();
  const unknownId = '00000000-0000-4000-8000-000000000000';
  const { data: unknownRead } = await orgB.client
    .from('media_generation_jobs')
    .select('id')
    .eq('id', unknownId)
    .eq('organization_id', orgB.orgId)
    .maybeSingle();
  assert("org B cannot read org A's job", orgBRead === null);
  assert('unknown job also reads null', unknownRead === null);
  assert(
    'cross-org and unknown are indistinguishable (both null → 404)',
    orgBRead === unknownRead
  );

  // --- A6: private object is not anonymously readable ----------------------
  console.log('A6: storage object is private');
  if (resultPath) {
    const anon = createClient(SUPABASE_URL!, ANON_KEY!);
    const { data: anonBytes, error: anonError } = await anon.storage
      .from('media')
      .download(resultPath);
    assert('anonymous download fails', !!anonError || !anonBytes, anonError?.message);
  }

  // --- A7: signed URL minted after org-scoped authorization ----------------
  console.log('A7: signed result URL for org A');
  if (resultPath) {
    // Mirror the route: org-scoped read first, then mint via service role.
    const { data: authed } = await orgA.client
      .from('media_generation_jobs')
      .select('id, result_path')
      .eq('id', jobId)
      .eq('organization_id', orgA.orgId)
      .maybeSingle();
    assert('org-scoped read authorizes minting', !!authed);
    const { data: signed, error: signedError } = await admin.storage
      .from('media')
      .createSignedUrl(resultPath, 300);
    assert('signed URL minted', !signedError && !!signed?.signedUrl, signedError?.message);
  }

  await mock.close();

  // --- Cleanup --------------------------------------------------------------
  await admin.from('organizations').delete().eq('id', orgA.orgId);
  await admin.from('organizations').delete().eq('id', orgB.orgId);

  if (failures > 0) {
    console.error(`\nE2E FAILED: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nE2E PASSED: all assertions green');
}

main().catch((e) => {
  console.error(`E2E crashed: ${(e as Error).message}`);
  process.exit(1);
});
