# TuGPT

AI-powered WhatsApp business assistant built with Next.js 16, React 19, and
Supabase. Customer messages in, AI-drafted replies out, **every draft reviewed and
approved by a person before anything is sent** — and today nothing is sent at all:
`whatsapp_integration` is off in code and in the database.

Phase 3A (Secure Inbound WhatsApp Foundation) and Phase 3B (AI Draft Generation)
are complete. The product direction since is [ADR-015](docs/adr/ADR-015-ai-business-operating-system.md);
the interface is Spanish-first per [ADR-017](docs/adr/ADR-017-spanish-first-internationalization.md).

## Tech Stack

| Layer | Technology |
|---------|---------|
| Package manager | pnpm 10.34+ |
| Monorepo orchestration | Turborepo |
| Web framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4, Radix UI (shadcn/ui) |
| Language | TypeScript 5.4+ (strict mode) |
| Database & Auth | Supabase (PostgreSQL, RLS, GoTrue) |
| AI providers | Langdock (sole provider; model **rotation over a four-model allowlist**, never `auto` — see [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md)) |
| Worker runtime | tsx — **in production as well as development** (ESM syntax in CJS mode, no `"type": "module"`; see `docs/production_environment.md` §4) |
| Testing | Vitest (JS/TS), pgTAP (SQL) |
| Linting | ESLint 9 (flat config) |

## Monorepo Structure

```
tugpt-nextjs-recovered/
├── apps/
│   ├── web/                    # Next.js application
│   └── worker/                 # Background workers (draft, WhatsApp) — run via tsx
├── packages/
│   ├── ai-orchestration/       # Prompt builder, provider selection, draft pipeline
│   ├── ai-providers/           # AI provider adapter pattern (active: Langdock; Logicc/Anymize adapters retained, unused)
│   ├── auth/                   # Supabase auth service & session management
│   ├── database/               # Supabase client, migrations, RLS policies
│   ├── feature-flags/          # Feature flag architecture
│   ├── jobs/                   # Background job abstraction
│   ├── observability/          # Structured logger, metrics collector, audit logging
│   └── security/               # Config validation, secret sanitization
├── supabase/
│   ├── migrations/             # SQL migrations (RLS, triggers, audit tables)
│   └── tests/database/         # pgTAP tests
├── deploy/                     # systemd unit, Caddy config, host preflight (check-host.sh)
├── docs/
│   ├── adr/                    # Architecture Decision Records (ADR-001 to ADR-017)
│   ├── status/                 # Phase status reports
│   └── production_environment.md
├── turbo.json
├── pnpm-workspace.yaml
└── eslint.config.mjs
```

## Quick Start

### Prerequisites

- Node.js 22 (CI pins `22.12.0`; both Dockerfiles use `node:22-alpine`)
- pnpm 10.34+
- Docker Desktop (for local Supabase)

### Installation

```bash
pnpm install --frozen-lockfile
```

### Environment

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env.local
```

Required variables:

| Variable | Purpose | Exposure |
|---------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Public (browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | Public (browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | **Secret** (server only) |
| `LANGDOCK_API_CODE` | Langdock API key (sole draft provider — see [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md)) | **Secret** (server only) |
| `LANGDOCK_ENDPOINT_URL` | Langdock endpoint (optional, has a default) | Server only |
| `LANGDOCK_MODELS` | Ordered rotation list, cheapest first, e.g. `gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5`. Defaults to the whole allowlist when unset. **This is the recommended setting.** | Server only |
| `LANGDOCK_MODEL` | Pins one model and disables rotation. The escape hatch; ignored when `LANGDOCK_MODELS` is also set | Server only |
| `GATEWAY_API_MASTRA_KEY` | Mastra orchestrator API key | **Secret** (server only) |
| `GATEWAY_API_URL` | Mastra endpoint | Server only |
| `IONOS_API_KEY` | IonOS AI Assistant API | **Secret** (server only) |
| `HUBSPOT_API_KEY` | HubSpot CRM API | **Secret** (server only) |
| `WHATSAPP_APP_SECRET` | Meta app secret; the webhook's HMAC key. **Must be non-empty before `whatsapp_integration` is enabled** — the route refuses every request while it is blank | **Secret** (server only) |
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook verification token. Same rule | **Secret** (server only) |
| `TUGPT_DOMAIN` | Public hostname (`tugpt.app`). Read by the Caddy reverse proxy only | Server only |
| `TUGPT_SECRET_KEY_<ID>` | Base64 of 32 random bytes. A key ring, not one key: `<ID>` lowercased with `_` → `.` is the `key_id` written on each `platform_secrets` row, so `TUGPT_SECRET_KEY_PLATFORM_V1` is `platform.v1`. Several may be set at once — that is how rotation works | **Secret** (server only) |
| `TRANSCRIPTION_MAX_MEDIA_BYTES` | Ceiling on one inbound voice note. Defaults to 8 MiB. A spend control, not a storage one: Gladia bills per second and bytes are the only proxy for duration before decoding | Server only |

**Two credentials are deliberately NOT environment variables.** The Gladia API
key and the Meta Graph access token live in `platform_secrets` (migration
`20260903000003`), encrypted by the application under a key the database never
holds. Adding `GLADIA_API_KEY` or a Graph token variable here will not be read
by anything. `docs/credential-handover.md` is the procedure for installing and
rotating them — the value is typed at a prompt with echo off, so it never
reaches shell history, argv, or a log.

The Graph token is used **only to download inbound audio**. The client that
holds it issues GET requests and has no code path that POSTs;
`whatsapp_integration` still gates every send, and
`apps/worker/tests/outbound-gate.test.ts` asserts both against the source.

**Model selection is a rotation, not `auto`.** `LANGDOCK_ALLOWED_MODELS` in
`packages/ai-providers/src/langdock.ts` is the four-model allowlist, and anything
outside it — including the string `auto` — is rejected at worker boot. Langdock's
OpenAI-compatible endpoint has no `auto` model and returns HTTP 400 for it. This
README claimed otherwise from 2026-08-18 until 2026-08-31; the correction was
recorded in `docs/production_environment.md` §1 on 2026-08-19 and did not reach
here. `apps/worker/tests/readme-matches-the-repo.test.ts` now fails on that
claim rather than waiting for someone to notice it again.

No `LOGICC_*`, `ANYMIZE_*`, or `MODEL` variables are needed: Logicc and Anymize
were removed on 2026-08-18 (cost and cross-project isolation, respectively), and
`MODEL`'s last reader was deleted with `AIProviderFactory` in PR #17. See ADR-006.

See `docs/production_environment.md` for the full security hardening guide.

### Development

```bash
pnpm exec turbo dev
```

### Testing

```bash
# JS/TS tests
pnpm exec turbo test

# Database tests (requires Docker)
pnpm exec supabase db reset
pnpm exec supabase test db
```

### Build & Quality Gates

```bash
pnpm exec turbo build        # Production build
pnpm exec turbo lint          # ESLint
pnpm exec turbo typecheck     # TypeScript
pnpm exec turbo test          # Vitest
```

Each of the four runs across **10 workspaces** — the 8 `packages/*`, plus `web`
and `worker` — so a full cold gate is 39 tasks (`build` is skipped for the
packages, which have no build step). Run it as one command:

```bash
pnpm exec turbo run lint typecheck test build --force
```

All four must pass before merge. The Turbo cache is disabled for `dev` and persisted for `build`.

## CI/CD

`.github/workflows/ci.yml` runs **four jobs**, all of them required:

| Job | What it does |
|---|---|
| `build-and-test` | `pnpm install --frozen-lockfile`, then `turbo run lint typecheck test build --force` |
| `database-tests` | `supabase db reset` + `supabase test db` (pgTAP) against the full migration chain |
| `docker-build` | Builds both images, so a Dockerfile break is caught in CI rather than on the host |
| `deploy-scripts` | Shell-lints and exercises `deploy/check-host.sh` against recorded fixtures |

It triggers on **every** pull request. It used to trigger only on PRs based on
`main`, which meant a stacked PR got no checks at all — no red gate, no gate —
and that is a distinction worth keeping in mind when reading any "CI green"
claim from before 2026-08-31.

All checks must pass. No manual SQL modifications to production schema; all changes go through migrations (`supabase db push`).

## Deployment

TuGPT runs on a self-managed VPS via Docker Compose, not Vercel — see
[ADR-013](docs/adr/ADR-013-vps-docker-deployment-target.md) for why, and
[`docs/production_environment.md`](docs/production_environment.md) (section 5)
for the deployment runbook (`docker-compose.yml`, `deploy/systemd/tugpt.service`,
`/etc/tugpt/*.env`).

## Architecture Decision Records

| ADR | Title | Status |
|---------|---------|---------|
| [ADR-001](docs/adr/ADR-001-monorepo-and-package-boundaries.md) | Monorepo and Package Boundaries | Accepted |
| [ADR-002](docs/adr/ADR-002-supabase-authentication-strategy.md) | Supabase Authentication Strategy | Accepted |
| [ADR-003](docs/adr/ADR-003-multi-tenant-organization-model.md) | Multi-Tenant Organization Model | Accepted |
| [ADR-004](docs/adr/ADR-004-rls-and-private-helper-functions.md) | RLS and Private Helper Functions | Accepted |
| [ADR-005](docs/adr/ADR-005-active-organization-context.md) | Active Organization Context | Accepted |
| [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md) | Provider Adapter Architecture | Provisional |
| [ADR-007](docs/adr/ADR-007-background-job-abstraction.md) | Background Job Abstraction | Accepted (amended by ADR-014) |
| [ADR-008](docs/adr/ADR-008-api-versioning-and-authorization.md) | API Versioning and Authorization | Accepted |
| [ADR-009](docs/adr/ADR-009-observability-and-audit-logging.md) | Observability and Audit Logging | Accepted |
| [ADR-010](docs/adr/ADR-010-feature-flag-architecture.md) | Feature Flag Architecture | Accepted |
| [ADR-011](docs/adr/ADR-011-secure-inbound-whatsapp-foundation.md) | Secure Inbound WhatsApp Foundation | Accepted |
| [ADR-012](docs/adr/ADR-012-three-provider-failover-chain.md) | Three-Provider Failover Chain | Superseded by ADR-006 |
| [ADR-013](docs/adr/ADR-013-vps-docker-deployment-target.md) | VPS + Docker Compose Deployment Target (Replacing Vercel) | Accepted |
| [ADR-014](docs/adr/ADR-014-pgmq-production-queue-backend.md) | PGMQ as the Production Queue Backend | Accepted |
| [ADR-015](docs/adr/ADR-015-ai-business-operating-system.md) | TuGPT as an AI Business Operating System | Accepted |
| [ADR-016](docs/adr/ADR-016-product-name-and-domain.md) | Product Name and Domain | Accepted |
| [ADR-017](docs/adr/ADR-017-spanish-first-internationalization.md) | Spanish Is the Source of Truth; Locale Belongs to the Organization | Accepted |

`apps/worker/tests/readme-matches-the-repo.test.ts` checks this table against
`docs/adr/` on every run: a new ADR that is not listed here fails, a row pointing
at a file that does not exist fails, and a status that disagrees with the ADR's
own `## Status` fails. The table stopped at ADR-014 for six days before that
guard existed.

## Security

- **Secret isolation**: Only `NEXT_PUBLIC_*` variables are exposed to the browser. `SUPABASE_SERVICE_ROLE_KEY` bypasses all RLS and must never be bundled client-side. `createAdminSupabaseClient` in `@tugpt/database` asserts `typeof window === 'undefined'` to block accidental client usage.
- **Row-Level Security**: All `public` tables enforce RLS (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`). The `private` schema holds RLS resolver functions and is inaccessible to the `anon` role.
- **Audit log immutability**: `trigger_prevent_audit_log_modification` blocks user-level `UPDATE` and `DELETE` on `public.audit_logs`.
- **Structured logging**: `@tugpt/observability` provides a `Logger` generating structured JSON records with automatic secret redaction (Bearer tokens, API keys, Supabase keys) in context values. As of PR #2, `err.message` is also sanitized to prevent secret leakage through error messages.
- **Config validation**: `@tugpt/security` validates environment configuration at startup.

## Current Status

- **Phase 2**: Complete. Release gate passed (lint, typecheck, test, build, pgTAP all green). Merged via PR #1.
- **Phase 3A** (Secure Inbound WhatsApp Foundation): Complete. Merged via commit `4c6551dd` on Aug 5, 2026. Local Docker gate passed: 131 application tests, 133 pgTAP assertions, production build, and typed SQLSTATE transport check all green.
- **Phase 3B** (AI Draft Generation): Complete. Merged via PR #4 (commit `61b7a899`) on Aug 6, 2026, followed by PR #5 (staging readiness) on Aug 7, and PR #7 (three-provider failover chain: Logicc → Langdock → Anymize) on Aug 12. 267 tests passing, lint/typecheck/build green. That chain **no longer exists** — see the 2026-08-18 provider simplification below. What survived it is the 25-second abort, the structured `ProviderError` classification, and content privacy (sanitized metadata only in logs).
- **PR #2** (Logger Secret Sanitization): Merged (squash) into main at commit `72ba4c2f` on Aug 12, 2026. Applies `sanitizeValue()` to `err.message` in the structured logger, preventing Bearer tokens and API keys in error messages from appearing in plaintext logs.
- **PR #8** (Documentation Update): Merged (squash) into main at commit `e6f2e9e` on Aug 12, 2026. Updated README, ADR-006, ADR-009, and `.env.example` for Phase 3B completion and the three-provider failover chain. Added ADR-012.
- **PR #10** (ESM/CJS Interop Fix): Merged (squash) into main at commit `4a79f02` on Aug 13, 2026. Removed `"type": "module"` from `apps/worker/package.json` to resolve `ERR_REQUIRE_ESM` crash-loop on staging. Internal packages remain CJS; workers execute via `tsx` which handles ESM syntax in CJS mode. Verified on staging: typecheck, lint, test (100/100), build all pass, both workers start cleanly.
- **PR #13** (Docker Compose deployment): Merged into `main` (merge commit `4092f48`) on Aug 18, 2026. Adds `apps/web/Dockerfile`, `apps/worker/Dockerfile`, `docker-compose.yml`, and a `docker-build` CI job, targeting the VPS deployment described below instead of Vercel.
- **PR #14** (Vercel cleanup, VPS runbook, ADR-013): Merged into `main` (merge commit `de1fe63`) on Aug 18, 2026, immediately after PR #13. Removes `vercel.json`, rewrites `docs/production_environment.md` §5 and ADR-013 for the real target (`212.227.44.13`), and adds the systemd-to-Docker-Compose cutover plan and pre-deploy security checklist.
- **Provider simplification** (2026-08-18): TuGPT moved from the three-provider failover chain to Langdock as the sole provider — Logicc cut (cost), Anymize removed (cross-project isolation), model selection set to what was then believed to be Langdock's automatic model selection (never pinned) — **which turned out not to exist**; corrected on 2026-08-19 to a rotation over a four-model allowlist. See [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md) (rewritten) and [ADR-012](docs/adr/ADR-012-three-provider-failover-chain.md) (superseded). `LogiccAdapter` and `AnymizeAdapter` remain in the repo, unimported by production wiring. Merged into `main` via PR #15 on Aug 18, 2026; `build-and-test` and `docker-build` both green on `main`. Milestone #1 (first end-to-end AI draft in staging) remains gated on the running staging workers' environment being confirmed updated with the live Langdock config, not just the repo.
- **Job-queue backend pinned** (2026-08-18): [ADR-014](docs/adr/ADR-014-pgmq-production-queue-backend.md) documents PGMQ (the Postgres extension, via Supabase) as the confirmed production queue backend for both `whatsapp_inbound` and `draft_generation`, resolving the "BullMQ/Redis or PgBoss" ambiguity left open in [ADR-007](docs/adr/ADR-007-background-job-abstraction.md). Documentation only, no code changes.

### Since 2026-08-18

The list above stopped there for two weeks. Everything below is merged on `main`.

- **Model rotation replaces `auto`** (2026-08-19). Langdock's OpenAI-compatible endpoint has no `auto` model — it returns HTTP 400. Selection became `LANGDOCK_MODELS` (an ordered rotation) or `LANGDOCK_MODEL` (pinned), validated at worker boot against a four-model allowlist. `docs/production_environment.md` §1.
- **Host compromise and rebuild** (2026-08-24). The VPS was compromised with root password SSH still enabled and had to be reinstalled. §5.2 of the production guide had been a prose checklist whose first item was "password auth is disabled"; nobody read it. It is now `deploy/check-host.sh`, which exits non-zero, and `deploy/check-host.test.sh` runs it against a fixture of the exact configuration the box was lost with.
- **Workers run under `tsx` in production too** (2026-08-25). The first ever container boot crash-looped on `ERR_MODULE_NOT_FOUND`: no `@tugpt/*` package produces a `dist/`, so the worker's CJS output `require()`s raw TypeScript. Every earlier path — dev, the e2e harness, the old systemd units — ran under `tsx` and hid it. `apps/worker/tests/worker-start-command.test.ts` fails anyone who reverts that. `docs/production_environment.md` §4.
- **[ADR-015](docs/adr/ADR-015-ai-business-operating-system.md) accepted** (2026-08-25): the product direction beyond draft review.
- **Quota-period lifecycle** (2026-08-26, migration `20260826000001`). `public.enable_draft_generation_for_org()` creates the period and enables the org flag in one transaction, and a trigger refuses to enable the flag for an organization with no covering period (`P3B17`). Before it, a missing period silently skipped every job.
- **Domain migration to `tugpt.app`** (2026-08-28): [ADR-016](docs/adr/ADR-016-product-name-and-domain.md).
- **Spanish-first interface** (2026-08-30): [ADR-017](docs/adr/ADR-017-spanish-first-internationalization.md). Typed `es`/`en` dictionaries with Spanish as the source of truth, a key-parity guard, and `organizations.locale` (default `es`) carried on `TenantContext` — never `Accept-Language`, because one shop's two reviewers must see one language.
- **The anti-invention guardrail** (2026-08-30). Emitted by `packages/ai-orchestration/src/prompt-builder.ts` for every draft, appended after every per-organization section: no invented prices, hours, availability, deadlines, promotions or policies; capture a contact detail instead; answer honestly if asked whether the reply is automated. It is **not** a seeded default an owner can clear — "mandatory" and "seeded" are not the same property, and the seeded `response_rules` deliberately does not repeat it.

41 migrations. `whatsapp_integration` is `false` in `packages/feature-flags/src/flags.ts` **and** in the database; enabling outbound is a two-key operation requiring explicit owner approval, every time ([ADR-010](docs/adr/ADR-010-feature-flag-architecture.md) amendment §2, `docs/controlled-rollout.md` §7).

## Contributing

1. Create a feature branch from `main`
2. Ensure all quality gates pass: `turbo run lint typecheck test build`
3. Open a PR with a clear description of the change
4. Scope PRs to a single concern
5. Follow existing code conventions (TypeScript strict, ESLint flat config)
6. No new dependencies without justification
