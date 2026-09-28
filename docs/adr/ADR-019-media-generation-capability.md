# ADR-019: Media Generation Capability (ComfyUI on the TuGPT GPU Host)

## Status

**Proposed** — technical review outstanding. D1 (self-hosted, open-source-only
direction, amending ADR-015 §4.3/§4.4) **confirmed by owner 2026-09-28**; the
remaining decisions await review. Phase A item 1 of the media work programme.

## Context

TuGPT needs image and video generation as a product capability: a business
describes a campaign asset in words and gets a file back, inside the same
tenancy, permission, and audit systems as everything else. The GPU host
(`terra-garda-gpu-worker01`) already runs ComfyUI 0.37.0 (loopback-only) with
verified open-source models: FLUX.1-schnell (images, Apache-2.0) and WAN 2.2
14B/5B (video) with the Lightning 4-step LoRAs.

Three constraints shape every decision below:

1. **ADR-015's binding rule:** no capability may have exactly one *possible*
   provider — including image and video.
2. **The existing `AIProviderAdapter` contract is text-only by design** and its
   own header forbids ad-hoc expansion. A media contract must arrive the way
   `TranscriptionProvider` did: a separate, typed interface beside it, not a
   widened method.
3. **The repository already solved the hard infrastructure problems** for two
   earlier pipelines (draft generation, transcription): PGMQ queues consumed
   only through `SECURITY DEFINER` RPC wrappers, RLS + composite tenant FKs,
   `is_feature_enabled` gates, `TEXT`+`CHECK` statuses, pgTAP suites with
   cross-org denial, and `failed_jobs` as the dead-letter union. The media
   capability mirrors those solutions; it invents only where the domain
   genuinely differs (GPU execution is slow, interruptible, and produces
   files).

`flux1-dev` is present on the host for evaluation only. Its licence is
non-commercial. It must not appear in any product path, allowlist, or fixture.

## Decision

### D1. Self-hosted, open-source only — amending ADR-015 §4.3/§4.4

**Confirmed by owner, 2026-09-28.** Image and video generation run on our own
GPU, with open-source models only. No HeyGen, no hosted image API, no paid
per-render vendor — not as configured routes, not as fallbacks. This amends
ADR-015 §4.3/§4.4, which had named vendor routes for these modalities.

The "no single possible provider" rule is then satisfied the way the rule
intends — by architectural routability, not by a vendor contract: the adapter
exposes a **route-selection seam**. A capability request (`image.generate` /
`video.generate`) is routed to a model family, and the adapter compiles the
matching fixed graph template. Nothing is hard-wired to one checkpoint:

- First routes: **WAN 2.2** (`video.generate`), **FLUX.1-schnell**
  (`image.generate`).
- Declared, evaluated-later candidates (architecture, not code — nothing is
  installed in Phase A): **HunyuanVideo** or **LTX-Video** for video;
  **Stable Diffusion 3.5** or **Qwen-Image** for images.

Every candidate is subject to a **licence check before anything is
downloaded**. The `flux1-dev` episode is the reason this is written down
rather than assumed.

### D2. Fixed, allowlisted graph templates — never caller-supplied graphs

Callers supply validated parameters. They never supply ComfyUI graphs, node
names, file paths, or model names. The adapter compiles requests into fixed
templates from an allowlist:

- **Images:** FLUX.1-schnell, verified 4-step workflow.
- **Video:** WAN 2.2 with Lightx2v, **4 steps by default**; the 20-step
  quality workflow is an explicit opt-in.
- **Bounds:** resolutions `1280×720` / `720×1280` / `832×480`; frame counts
  `4n+1 ≤ 81`; prompt `1–1000` characters; fixed step count per lane.

The allowlist is **verified against ComfyUI `/object_info` at worker
startup**, and the worker **fails closed** on any mismatch (missing model,
missing LoRA, unexpected node signature). The Langdock static allowlist is the
in-repo precedent; the live verification is the new part, and it exists
because a graph compiled against a model that is not there is a silent wrong
result, not an error.

### D3. A separate media contract in `packages/ai-providers`

The media contract lives in its own file beside `adapter.ts` (precedent:
`transcription.ts`), typed for the domain: capability (`image.generate` /
`video.generate`), validated parameters, route selection, and a result handle.
The text-only `AIProviderAdapter` is not touched. Phase B item 5 will
formalise the capability-negotiated contract of ADR-015 D2; this adapter is
written as its **first implementation**, not as a one-off client.

### D4. The job lifecycle: prompt_id first, reconcile on restart, never blind

- The job row is saved **before** submission, and the returned ComfyUI
  `prompt_id` is persisted **before** any polling (precedent:
  `record_transcription_submission` — a billed/submitted unit of work whose
  handle is lost is unrecoverable).
- After a worker restart, unfinished jobs are reconciled against **both**
  `/history/<prompt_id>` **and** `/queue`. An empty history is **not**
  failure while the prompt is still queued or running; the worker must not
  blindly resubmit an uncertain job (a resubmission is a second GPU run of a
  job that may already be rendering).
- Terminal mapping: `execution_error` → `FAILED`; `execution_interrupted` →
  `CANCELLED` (with reason); a prompt_id whose history stays empty *and* is
  absent from `/queue` after restart → `FAILED` with a distinct reason, never
  `RUNNING` forever.
- `POST /interrupt` is never issued globally: the worker interrupts only the
  prompt it submitted, after confirming that prompt is the one running.

### D5. One active job per organisation, enforced by the database

Concurrency guard: a **partial unique index**

```sql
CREATE UNIQUE INDEX media_generation_jobs_one_active_per_org
  ON public.media_generation_jobs (organization_id)
  WHERE status IN ('queued', 'processing');
```

The enqueue RPC catches `unique_violation` and raises
`MEDIA_CONCURRENCY_EXCEEDED` (P3M09). The advisory-lock alternative was
considered and rejected: an index is declarative, enforced at the storage
layer regardless of which code path inserts, and consistent with the repo's
tenancy discipline (isolation guaranteed by the database, not by the caller).
pgTAP must cover the two-concurrent-callers case.

**Wording discrepancy, recorded explicitly:** the approved guard was specified
as `status IN ('queued','running')`. The repository's status vocabulary — used
by `draft_generation_jobs` and `transcription_jobs` — has no `'running'`; the
in-flight state is `'processing'`. The index uses `('queued','processing')`.
This is a naming alignment, not a semantic change.

### D6. Status and error vocabulary: extend, don't invent

Statuses extend the existing vocabulary —
`('queued','processing','completed','skipped','cancelled','dead_lettered')` —
adding only `'cancelled'` (with `cancel_reason`), which media genuinely needs.
`TEXT` with `CHECK`, never a Postgres `ENUM` (ADR-015 Part 3 row 11).

Error codes follow the SQLSTATE-style families: a new **P3M** family shaped
like P3B (draft) and P3I (transcription), and the `failed_jobs` allowlist
grows by the worker's terminal codes. The worker's produced codes must stay a
subset of the archive RPC's allowlist — the 2026-08-19 draft incident is the
reason this is a rule rather than a suggestion.

### D7. Storage: private bucket, signed URLs, ComfyUI never exposed

Supabase Storage is greenfield in this repo — nothing exists. Decision: a
private `media` bucket; object keys are `<org_id>/<job_id>.<ext>` **inside**
the bucket (the bucket name is not part of the key); the worker streams
finished files via ComfyUI `GET /view` into the bucket; customers receive
**short-lived signed URLs minted server-side** (service_role).
`complete_media_job` enforces the exact `<org_id>/<job_id>.<png|mp4>` shape
in the database, so a wrong key can never be recorded. ComfyUI's API and
filesystem are never reachable from customer paths.

### D8. API surface follows the conversations route pattern

`POST /api/v1/media/` (enqueue) and `GET /api/v1/media/<id>` (status/result),
following `apps/web/src/app/api/v1/conversations/route.ts`: session →
`resolveTenantContext` (the `x-tenant-id` header is a hint validated against
`organization_members`; the org never comes from client-controlled params) →
feature gate → `{ error: { code, message } }` envelope with SQLSTATE-mapped
codes.

### D9. Flags gate rollout; entitlements stay separate

`is_feature_enabled(org, 'media_generation')` — global AND org rows must be
true, missing is disabled — is the operative gate, checked in the enqueue RPC.
Per ADR-015 D5, entitlements are a different system with a different
lifecycle: the entitlement/metering framework is schema-ready but unenforced
in this repo, and item 1 does not invent a parallel quota table. Per-render
metering rides the entitlement wiring when it lands; the enqueue RPC carries
a marked extension point for it.

### D10. Deployment: unprivileged media worker beside ComfyUI

The media worker runs as its own container on the GPU host, on the
administrator-configured `tugpt_media_net`, reaching ComfyUI at
`http://comfyui:8188`. It publishes no ports, gets no GPU device, and gets no
Docker socket. One consumer, one active GPU job at a time.

`tugpt_media_net` is a **proposal only** in the compose file: creating or
attaching that network is a server change and needs separate approval. The
compose file and boot-check registration ship for review; the running stack
is not touched without approval.

## Consequences

- Phase A item 2 (adapter) and item 3 (worker) implement this ADR; review
  measures them against it.
- A second model family can be added later by extending the route table and
  its per-route allowlist — no adapter rewrite, no second backend service.
- The `media_generation` flag ships disabled everywhere; enabling it for an
  org is a deliberate two-row change, and spend control is the flag until
  entitlements are wired.
- pgTAP for the migration must include the two-concurrent-callers case; it
  has no in-repo precedent and is invented here (single-session serialized
  approximation with an explicit TODO for a true two-session test).

## Open questions / deferred

1. Per-render metering: rides the entitlement framework when wired (see D9).
   No usage table is created in item 1.
2. Signed-URL TTL default: proposed 15 minutes; confirm at API review.
3. Whether `cancelled` jobs should appear in the dead-letter runbook tooling:
   no — cancellation is not failure; only `dead_lettered` rows land in
   `failed_jobs`.
4. **Real quotas (per day and per month) are a blocker before launch.**
   Phase A ships one-active-job-per-org and no quota system; the numbers —
   renders per org per day, per month, and what happens on exceed — must be
   decided and enforced before this goes live.
