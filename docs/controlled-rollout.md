# Controlled rollout: turning on AI draft generation

**Status:** active procedure
**Applies to:** `ai_draft_generation` on `212.227.44.13` / project `rbiumegrwtavmljxbknp`
**Flag semantics this depends on:** ADR-010, "Amendment (2026-08-19): what the flags actually do"

> **Outbound WhatsApp is out of scope.** `whatsapp_integration` stays off. Nothing in this document
> turns it on, and nothing in this document can — see §7. Enabling outbound customer messaging
> requires explicit owner approval, every time, without exception.

---

## 1. The two switches

`public.is_feature_enabled(org, key)` is a **logical AND** of the global row
(`organization_id IS NULL`) and the org row. It is not an override chain. Everything below follows
from that one fact:

- **Global row = the arming switch.** While it is `false`, the feature is off for every
  organization regardless of what their own rows say. Setting it to `true` turns the feature on for
  *nobody* — it only stops the global row from vetoing.
- **Org row = an allowlist entry.** An organization is enabled only when it has its own row set to
  `true` *and* the global row is `true`. An organization with no row resolves to `false`.

This is why a pilot cannot be run with the global row left `false`, and why arming globally is not
the risk it sounds like: with zero org rows, arming changes nothing observable. §3 proves that
rather than assuming it.

## 2. Before you start

- [ ] Migrations applied and the harness preflight passes — `docs/server-migrations.md` §4.
- [ ] Both workers active on the deployed commit. They are **containers**, not
      systemd units — this host has no `tugpt-draft-worker` /
      `tugpt-whatsapp-worker` unit and never had one
      (`docs/production_environment.md` §5.1):

      ```bash
      cd /opt/tugpt
      docker compose -p tugpt ps --status running --services \
        | grep -E '^(whatsapp-worker|draft-worker)$'   # both must print
      ```
- [ ] `LANGDOCK_API_CODE` present in `/etc/tugpt/worker.env`
      (`docs/milestone1-e2e-runbook.md` §6a). Model selection is `LANGDOCK_MODELS` — the ordered
      rotation list, and the recommended setting. `LANGDOCK_MODEL` pins a single model and disables
      rotation; it is the escape hatch, and it is ignored when `LANGDOCK_MODELS` is also set.
      Neither is required: unset, the worker rotates the whole allowlist. See ADR-006. Do not
      assume which is configured — the worker resolves it at boot and says so:
      `cd /opt/tugpt && docker compose -p tugpt logs --tail=50 draft-worker | grep 'model order resolved'`.
- [ ] Each pilot organization has a **live quota period** — a `draft_quota_limits` row whose
      `period_start <= CURRENT_DATE < period_end`. Without one, every job is skipped.
      **It lands in the database as `skip_reason = 'QUOTA_DENIED'`,** not as
      `NO_ACTIVE_QUOTA_PERIOD` — that is a `reason` returned by `private.reserve_draft_usage`
      which the worker logs and does not persist. Looking for it in `draft_generation_jobs` finds
      nothing and reads like the quota check never ran.

      **As of migration `20260826000001` you no longer have to remember this.**
      `public.enable_draft_generation_for_org(org_id, hard_ceiling)` creates the period and
      enables the org flag in one transaction, and a trigger on `feature_flags` refuses to enable
      the flag for an org with no covering period (`P3B17 DRAFT_QUOTA_PERIOD_REQUIRED`). The
      checklist item survives as a *check*, not as a thing to do by hand — see §4.
- [ ] Each pilot organization has an `ai_draft_configs` row. The worker looks the config up by
      `(business_profile_id, organization_id)`, taking the `business_profile_id` from the job row.
      **The only reachable failure is that no config row exists** — a config cannot point at
      another organization's profile, because `ai_draft_configs` carries a composite foreign key on
      `(business_profile_id, organization_id)` referencing `business_profiles(id, organization_id)`,
      and `business_profiles` is `UNIQUE (organization_id)`. An earlier version of this checklist
      described a "stale profile id" risk; the database refuses that write, so there is one thing
      to check here rather than two. Note the FK is `ON DELETE CASCADE`: deleting the profile takes
      the config with it, which *is* a way to arrive at no config.

      This is not a quality nicety: a missing or mismatched row **dead-letters the job** with
      `DRAFT_INVALID_CONFIG`. It is the most likely way a first pilot produces zero drafts while
      nothing looks misconfigured. Prove it rather than assuming it:

      ```sql
      -- The pilot org's profile, and whether a draft config resolves for it.
      -- Expect exactly one row with config_id NOT NULL.
      SELECT bp.id AS business_profile_id, bp.display_name, c.id AS config_id
      FROM public.business_profiles bp
      LEFT JOIN public.ai_draft_configs c
        ON c.business_profile_id = bp.id AND c.organization_id = bp.organization_id
      WHERE bp.organization_id = '<ORG_UUID>';
      ```
- [ ] You know who is watching, and for how long. Step 4 is not optional.

Run every statement below against the database with a service-role or owner connection. Take the
"before" reading in §3 first — you will want it if you have to explain what changed.

## 3. Arm globally, and prove nothing turned on

```sql
-- Before: every row for this flag.
SELECT organization_id, is_enabled
FROM public.feature_flags
WHERE key = 'ai_draft_generation'
ORDER BY organization_id NULLS FIRST;
```

Expect the global row, `organization_id = NULL`, `is_enabled = false`.

**Every org row that is already `true` will go live the instant you arm.** So the check is not
"is there an org row" — §4 can legitimately be run days ahead, and preparing pilot organizations
early is recommended precisely because it changes nothing while the global row is `false`. The
check is:

> **Stop unless the enabled org rows are exactly the ones you armed on purpose, and there are no
> others.**

That requires a list of the organizations you armed deliberately, written down *before* you run
this query — otherwise you are comparing the output against your memory, which is not a control.
For a single pilot organization it is one line.

This is not hypothetical. Arming two organizations and then arming globally turns on both, which
is correct behaviour and a surprise if only one was intended.

```sql
-- Arm.
UPDATE public.feature_flags
SET is_enabled = true, updated_at = now()
WHERE organization_id IS NULL AND key = 'ai_draft_generation';
```

Now prove the claim in §1 rather than trusting it:

```sql
-- Must return zero rows. Any row here is an organization that just became live.
SELECT o.id, o.slug
FROM public.organizations o
WHERE o.deleted_at IS NULL
  AND public.is_feature_enabled(o.id, 'ai_draft_generation');
```

If that returns anything, disarm immediately (§6) and find out why before continuing.

## 4. Enable the first organization

One organization. Not two, not "the small ones".

```sql
-- Creates the quota period AND enables the org flag, in one transaction.
-- Idempotent: safe to re-run, and it will not overwrite a live ceiling.
SELECT * FROM public.enable_draft_generation_for_org('<ORG_UUID>', <HARD_CEILING>);
```

Read the returned row before going further. It answers three questions at once:

| Column | What it tells you |
|---|---|
| `quota_created` | `true` = a period was created now. `false` = one already covered today and was reused, which is fine. |
| `period_start` / `period_end` / `hard_ceiling` | The window jobs will be counted against, and the ceiling. |
| `global_flag_enabled` | Whether §3 actually armed. |
| `effective` | **What `is_feature_enabled` will answer.** This is the one that matters. |

`effective` is `false` unless the global row is *also* `true`. That is the design, not a fault:
running this RPC for an organization changes nothing observable until the global row is armed, so
you can prepare every pilot org ahead of the session and still start nothing.

```sql
-- Confirm the intended org resolves true, and re-confirm nobody else does.
SELECT o.slug, public.is_feature_enabled(o.id, 'ai_draft_generation') AS enabled
FROM public.organizations o
WHERE o.deleted_at IS NULL
ORDER BY enabled DESC, o.slug;
```

Exactly one `true`. Note the time — the monitoring window starts now.

> **If you enable the flag by hand instead** — a raw `INSERT` into `feature_flags`, which is what
> this section said before migration `20260826000001` — and the organization has no quota period
> covering today, the statement is **refused** with `P3B17 DRAFT_QUOTA_PERIOD_REQUIRED`. That is
> the guard working. Before it existed, the same action succeeded and then skipped every job with
> `skip_reason = 'QUOTA_DENIED'`, which looks like a provider problem and is not one. Use the RPC.

### Rolling back one organization

```sql
SELECT * FROM public.disable_draft_generation_for_org('<ORG_UUID>');
```

`effective` comes back `false`. The organization's `draft_quota_limits` rows are **deliberately
left in place** — they carry the consumed usage for the period, which is exactly the record you
want to keep after a rollback. To stop *everything* at once, disarm globally instead (§6).

## 5. Watch

Watch for **at least one full business day**, and through at least one busy period. Drafts are only
generated when customers actually message, so a quiet evening proves nothing.

**Job outcomes.** The single most informative query:

```sql
SELECT status, error_code, skip_reason, count(*), max(created_at) AS latest
FROM public.draft_generation_jobs
WHERE organization_id = '<ORG_UUID>'
  AND created_at > now() - interval '24 hours'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

This table is the complete set of terminal outcomes — every value the worker can
write to `skip_reason` or `error_code`, with nothing omitted.
`apps/worker/tests/controlled-rollout-doc.test.ts` asserts that: it reads the rows
between the markers below and fails if they do not match `DRAFT_SKIP_REASONS` and
`APPROVED_ARCHIVE_ERROR_CODES` in the worker source, exactly, in both directions.
A code added to the worker without a row here turns CI red, and so does a row here
naming a value the worker cannot produce — which is how the `NO_ACTIVE_QUOTA_PERIOD`
that used to be in this document survived as long as it did.

<!-- outcome-table:start -->

| What you see | What it means | Do |
|---|---|---|
| `completed`, no error | working | continue |
| `skipped` / `FEATURE_DISABLED` | the AND did not resolve true — usually the global row | re-check §3 |
| `skipped` / `QUOTA_DENIED` | no live quota period, or the ceiling is hit. The *only* skip reason a quota denial produces, whatever the underlying cause | fix the quota, not the flag; §5 "Cost and quota" tells you which |
| `dead_lettered` / `DRAFT_INVALID_CONFIG` | no `ai_draft_configs` row resolves for this job's `(business_profile_id, organization_id)` | run the §2 config query; this is a hard failure, not degraded output |
| `dead_lettered` / `DRAFT_INVALID_REQUEST` | the job row, or its source message, could not be loaded; or the provider rejected the request as malformed | read `failed_jobs.provider_error_detail`; it quotes the provider |
| `dead_lettered` / `DRAFT_PROVIDER_CONFIG_ERROR` | `LANGDOCK_API_CODE` is **missing**, or the configured models are not on the allowlist — the worker could not construct a provider at all | fix the env file, restart the worker |
| `dead_lettered` / `DRAFT_PROVIDER_AUTH_ERROR` | Langdock **rejected** the credential (401/403). Distinct from the row above: the key is present and wrong, not absent | rotate or correct `LANGDOCK_API_CODE`, restart the worker |
| `dead_lettered` / `DRAFT_EXHAUSTED_RETRIES` | three genuinely transient failures | Langdock is degraded; single-provider means no fallback (ADR-006) |
| `dead_lettered` / `DRAFT_MALFORMED_RESPONSE` | the provider answered, but not in a shape the orchestrator could parse | `provider_error_detail`; if it repeats, the model or endpoint changed under us |
| `dead_lettered` / `DRAFT_PROVIDER_EMPTY_OUTPUT` | the provider returned success with no text | usually a content filter or a degenerate prompt; check `ai_draft_configs` |
| `dead_lettered` / `DRAFT_PROVIDER_OUTPUT_TOO_LONG` | the draft exceeded `ai_draft_configs.max_draft_length` | raise the limit or tighten `response_rules` |
| `dead_lettered` / `DRAFT_INTERNAL_ERROR` | an unclassified failure inside the worker | `docker compose -p tugpt logs draft-worker`; this one is a bug until proven otherwise |
| Anything at all in a **different** organization | isolation failure | **disarm now** (§6) |

<!-- outcome-table:end -->

`DRAFT_PROVIDER_ERROR`, `DRAFT_GENERATION_TIMEOUT` and `DRAFT_QUOTA_EXCEEDED` also
pass the `failed_jobs` CHECK constraint, but no code path produces them. They are
legacy allowlist entries. Seeing one means something other than this worker wrote
the row.

### Voice transcription outcomes

A separate switch and a separate worker, so a separate table. Nothing below can
occur until `voice_transcription` is true for an organization — and because the
enqueue reads *both* flags, a voice note arriving while `ai_draft_generation` is
off is never transcribed at all.

The thing to hold in mind reading this table is that **Gladia bills on
submission**. A dead letter here may name work that was already paid for; the
`TRANSCRIPTION_TIMEOUT` row is exactly that case, and it is why that code exists
separately from `TRANSCRIPTION_EXHAUSTED_RETRIES`.

<!-- transcription-outcome-table:start -->

| What you see | What it means | Do |
|---|---|---|
| `completed`, no error | working. An **empty** transcript is also success: a silent recording transcribes to nothing, is billed anyway, and enqueues no draft | continue |
| `skipped` / `FEATURE_DISABLED` | `voice_transcription` went false between enqueue and processing | nothing was spent; re-check §3 if unintended |
| `skipped` / `DRAFT_DISABLED` | `ai_draft_generation` went false. Transcribing now would pay for a transcript no reviewer will act on | nothing was spent |
| `dead_lettered` / `TRANSCRIPTION_PROVIDER_CONFIG_ERROR` | no `gladia/api_key` row in `platform_secrets`, or the key ring cannot open it — no provider could be constructed | `docs/credential-handover.md` §2; the key is **absent**, not wrong |
| `dead_lettered` / `TRANSCRIPTION_PROVIDER_AUTH_ERROR` | Gladia **rejected** the key (401/403). Distinct from the row above: present and wrong, not absent | rotate it per `docs/credential-handover.md` §3 |
| `dead_lettered` / `TRANSCRIPTION_MEDIA_AUTH_ERROR` | no `meta/graph_access_token` row, or Meta rejected it. A **different credential** from the two above | fix the Graph token, not the Gladia key |
| `dead_lettered` / `TRANSCRIPTION_MEDIA_TOO_LARGE` | over `TRANSCRIPTION_MAX_MEDIA_BYTES` (8 MiB default). Terminal on the first attempt — a recording does not shrink | nothing was spent; raise the ceiling only deliberately, it is a cost control |
| `dead_lettered` / `TRANSCRIPTION_MEDIA_UNAVAILABLE` | Meta will not serve that media id — expired, deleted, or never ours; or the metadata response had an unusable shape | nothing was spent. Meta expires media; an old queued job is the ordinary cause |
| `dead_lettered` / `TRANSCRIPTION_TIMEOUT` | we stopped waiting after 300s. **The job is still running at Gladia and is still billed** | `transcription_jobs.provider_job_reference` is the handle; the result can still be collected by hand |
| `dead_lettered` / `TRANSCRIPTION_EXHAUSTED_RETRIES` | three genuinely transient failures — Meta 5xx, truncated downloads, or Gladia unavailable | check both vendors before suspecting the worker |
| `dead_lettered` / `TRANSCRIPTION_MALFORMED_RESPONSE` | Gladia answered in a shape the adapter would not accept. Most often a finished job reporting no usable `billing_time` — the adapter refuses to substitute `audio_duration`, because that understates every stereo file by 100% | `provider_error_detail`; if it repeats, the API changed under us |
| `dead_lettered` / `TRANSCRIPTION_PROVIDER_ERROR` | Gladia rejected the request or failed the job for a reason that is not auth, config, or shape | `provider_error_detail`; it quotes the provider |
| `dead_lettered` / `TRANSCRIPTION_INTERNAL_ERROR` | unclassified failure inside the worker | `docker compose -p tugpt logs transcription-worker`; a bug until proven otherwise |
| A voice note transcribed **twice** | a resume path failed | **stop the worker.** This is the one failure that costs money per occurrence; check `provider_job_reference` was being written |

<!-- transcription-outcome-table:end -->

**Transcription dead letters:**

```sql
SELECT created_at, error_code, attempts, provider_error_detail
FROM public.failed_jobs
WHERE queue_name = 'transcription'
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

**What each voice note cost** — `audio_seconds` is Gladia's own billed quantity
(duration times channels), not the wall-clock length, so a stereo recording
correctly shows roughly twice its duration:

```sql
SELECT e.occurred_at, e.provider, c.quantity AS audio_seconds, c.cost_micros
FROM public.provider_usage_events e
JOIN public.provider_usage_components c ON c.event_id = e.id
WHERE e.organization_id = '<ORG_UUID>'
  AND e.modality = 'audio'
ORDER BY e.occurred_at DESC;
```

A `NULL` `cost_micros` means no price is seeded for that provider and dimension.
The row is deliberately still recorded: the call happened and Gladia will charge
for it, so losing the row would destroy the only evidence, and pricing it at zero
would under-report the organization's consumption. Unpriced rows are countable,
which is the difference between a known gap and a wrong number.

**Dead letters, with the provider's own words:**

```sql
SELECT created_at, error_code, attempts, provider_error_detail
FROM public.failed_jobs
WHERE queue_name = 'draft_generation'
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

**Cost and quota** — the reason the model allowlist exists:

```sql
SELECT period_start, period_end, draft_count, reserved_count
FROM public.draft_usage_tracking
WHERE organization_id = '<ORG_UUID>';

-- Per-model attribution. Meaningful from 20260819000003 onward; before that,
-- completed job rows carried provider = NULL, model = NULL.
SELECT provider, model, status, count(*)
FROM public.draft_generation_jobs
WHERE created_at > now() - interval '24 hours'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

`reserved_count` climbing while `draft_count` does not means reservations are being taken and not
consumed — jobs are failing after reserving. Look at `failed_jobs`.

**Are humans actually reviewing?** A rollout where drafts pile up unreviewed has not succeeded; it
has just created a queue.

```sql
SELECT d.status, count(*)
FROM public.ai_drafts d
WHERE d.organization_id = '<ORG_UUID>'
  AND d.created_at > now() - interval '24 hours'
GROUP BY 1;
```

Also worth reading directly, because it is the reviewers' actual verdict: a high `reject` rate in
`ai_draft_review_events`, or every approval preceded by an `edit`, means the drafts are not good
enough yet even though nothing is failing.

**Workers:**

```bash
cd /opt/tugpt
docker compose -p tugpt ps --status running --services \
  | grep -E '^(whatsapp-worker|draft-worker)$'   # both must print
docker compose -p tugpt logs --since 1h draft-worker | grep -i -E 'error|archiv|dead'
```

**An empty result from a log command is only good news if the command can
produce output at all.** `journalctl -u tugpt-draft-worker` — which this section
used to say — prints nothing on this host, because no such unit exists. Watching
that for a business day and seeing no errors would have proved nothing, and would
have read exactly like a clean rollout.

## 6. Expanding, and stopping

**Expand** one organization at a time, repeating §4 and §5 for each. Never enable a batch — with a
batch you learn that *something* broke, not *what*.

**Stop everything, instantly.** One statement, no deploy, no restart:

```sql
UPDATE public.feature_flags
SET is_enabled = false, updated_at = now()
WHERE organization_id IS NULL AND key = 'ai_draft_generation';
```

That is the kill switch. Every organization resolves `false` on the next evaluation. Verify:

```sql
SELECT count(*) AS still_enabled
FROM public.organizations o
WHERE o.deleted_at IS NULL
  AND public.is_feature_enabled(o.id, 'ai_draft_generation');   -- expect 0
```

Reach for the kill switch first and diagnose afterwards. Org rows can stay as they are; the global
`false` vetoes all of them, and leaving them in place means re-arming resumes exactly the previous
population — which is also the thing to remember before re-arming.

**Stop one organization** without affecting the others — equivalent to the RPC in §4, and safe to
use directly because the quota guard only applies to *enabling*:

```sql
UPDATE public.feature_flags
SET is_enabled = false, updated_at = now()
WHERE organization_id = '<ORG_UUID>' AND key = 'ai_draft_generation';
```

In-flight jobs are unaffected either way: the flag is evaluated when a job is processed, so work
already in the queue drains under the old answer. Neither statement cancels anything already
generated, and neither deletes a draft.

## 7. What this procedure cannot do

It cannot send anything to a customer.

`whatsapp_integration` is enforced in two unrelated places (ADR-010, amendment §2). The WhatsApp
webhook — the only inbound path Meta can reach — reads a **hardcoded** value in
`packages/feature-flags/src/flags.ts`, not the database. Flipping the database row does not open the
webhook; only a reviewed code change going through CI does.

Two rules follow, and they are the point of this section:

- Do not read the database `whatsapp_integration` row as the state of the webhook. It is the state
  of everything *except* the webhook.
- Enabling outbound is a **two-key operation** — the code default *and* the database row — and both
  keys turn only with explicit owner approval, per the standing directive.

A third thing must be true before either key turns, and it is not a key: both `WHATSAPP_APP_SECRET`
and `WHATSAPP_VERIFY_TOKEN` must be non-empty in `/etc/tugpt/web.env`. The route refuses everything
while either is blank (§5.4 of `docs/production_environment.md`), so a flip with a missing line
produces an endpoint that rejects Meta silently rather than an open one — which is the correct
failure, and still a failure worth not discovering during a supervised window.

Until then, the end of the pipeline is a human clicking Approve in the dashboard. Nothing after
that step exists yet, which is exactly the intended state.
