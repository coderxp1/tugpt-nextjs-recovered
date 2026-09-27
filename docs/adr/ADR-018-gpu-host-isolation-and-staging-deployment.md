# ADR-018: Dedicated GPU Host Architecture, Staging Deployment, and Administrative Control

## Status
Approved

**Date:** 2026-09-26 (Updated from initial 2026-09-15 draft)  
**Deciders:** Klaus Hoffmann, TuGPT Technical Review, TuGPT Infrastructure Team, Antigravity Development Team  
**Consulted:** ADR-006, ADR-010, ADR-013, ADR-014, ADR-015, ADR-019  

---

## 1. History & Evolution

- **Initial Draft (2026-09-15):** Originally targeted a shared host (`31.47.228.55` / `FINZIA-GPU-01`, 48 GB vGPU) carrying a co-tenancy workload ("The Infected App" / ComfyUI) and unverified CineDrama model assets. Under that initial posture, a total GPU moratorium was imposed on TuGPT container services to prevent VRAM contention and out-of-memory (OOM) failures on the co-located workload.
- **Revision & Dedicated Host Selection (2026-09-25):** The target environment was superseded by a brand-new, dedicated GPU server (`terra-garda-gpu-worker01`, `45.84.65.105`) equipped with an NVIDIA RTX PRO 6000 Blackwell Server Edition (96 GB VRAM). Co-tenancy risks were eliminated: no third-party workloads run on the new host, and model assets (`/srv/ai/models/`) are SHA-256 verified against Hugging Face. The GPU moratorium for ComfyUI was lifted for an administrator-managed loopback-only service (`http://127.0.0.1:8188`), while worker containers remain unprivileged with zero direct GPU device access.

---

## 2. Context and Problem Statement

TuGPT operates a dedicated GPU host `terra-garda-gpu-worker01` (`45.84.65.105`) running Ubuntu 26.04.1 LTS (kernel 7.0.0-34-generic), NVIDIA driver `580.178.04`, CUDA 13.0, Docker 29.1.3, Compose 2.40.3, and NVIDIA Container Toolkit 1.20.1.

The server hosts ComfyUI v0.37.0 in an unprivileged container (`comfy`, UID 2001) bound strictly to loopback `127.0.0.1:8188`.

We need to formalize:
1. Privileged administrator deployment boundaries and staging launch hygiene.
2. Runtime-only container compose manifests and fail-closed preflight release validation.
3. Network loopback isolation, cgroup resource limits, and queue governance.
4. Off-host developer verification with zero live host access during development.

---

## 3. Decision Drivers

- **Administrative Control & Hardened Boundary:** Developer accounts have no sudo, no Docker socket access, and no live interactive shell access on the host. Deployment is executed exclusively by an authorized host administrator using root-owned launchers.
- **Fail-Closed Release Validation:** Preflight automation must validate administrator release manifests (`release-manifest.json` schema v1.0.0), immutable `@sha256:` image digests, web-only key allowlists, and purge ambient secrets (`TUGPT_SECRET_KEY_*`).
- **Network & Topology Governance:** ComfyUI is bound strictly to `127.0.0.1:8188`. Container services connect over an internal Docker network (`tugpt_media_net`). Host loopback isolation ensures containers cannot access unexposed host services.
- **Queue Protection Invariant:** TuGPT maintains at most one authorized consumer per queue (`whatsapp_inbound`, `draft_generation`, `transcription`, `media_jobs`). Staging rehearsal omits production queue consumers.
- **Empirical Automated Verification:** Every security invariant and preflight rule must be covered by off-host integration and preflight tests in CI (`apps/worker/tests/integration/staging-functional-smoke.test.ts` and `staging-deployment-preflight.test.ts`).

---

## 4. Decision

### 4.1 Host Inventory & Access Boundaries
- **Host:** `terra-garda-gpu-worker01` (`45.84.65.105`).
- **OS / Hardware:** Ubuntu 26.04.1 LTS, 24 vCPU, 94 GiB RAM, 16 GiB swap.
- **GPU:** NVIDIA RTX PRO 6000 Blackwell (96 GB VRAM).
- **SSH Security:** Key-only auth for account `klaus` only (`AllowUsers klaus`), `PermitRootLogin no`, `PasswordAuthentication no`.
- **Firewall:** `ufw` default deny incoming, allow outgoing, OpenSSH rate-limited.
- **Developer Access:** Zero developer access to GPU host. All development builds against contract specs and recorded offline fixtures.

### 4.2 Administrator Launcher & Deployment Invariants (`deploy/staging/launch-staging.sh`)
1. **Effective Root UID (0) Check:** Launcher requires `id -u == 0`; exits 2 immediately if called by non-root users.
2. **Fixed Canonical Bundle Path:** Binds strictly to `/etc/tugpt/staging/` with no parameter overrides.
3. **Exact Root Ownership & Modes:** Directories `0700`, configuration / manifest files `0600`, executable scripts `0700`, all owned by `root:root` (`0:0`).
4. **Parent Directory Trust:** Asserts root ownership (`0:0`) and non-world-writable modes (`0755` or stricter) on parent directories `/etc` and `/etc/tugpt`.
5. **Symlink Rejection:** Strictly rejects symlinks across directory and file paths.
6. **Clean Execution Environment:** Minimal `env -i PATH=... HOME=/root` execution environment.
7. **Controlled Compose Invocation:** Passes `--env-file /dev/null` to Docker Compose.
8. **Mandatory Preflight Abort:** Contact with Docker daemon is strictly prohibited until preflight validation succeeds.

### 4.3 Release Preflight & Manifest Validation (`deploy/staging/check-staging-env.sh`)
- **Administrator Release Manifest:** Adheres to JSON schema v1.0.0 (`schemaVersion: 1.0.0`, `targetEnvironment: staging`).
- **Image Digest Integrity:** Enforces repository `ghcr.io/coderxp1/tugpt-web` with exact 64-hex `@sha256:` digest (no mutable tag fallback).
- **Web-Only Key Allowlist:** Rejects unknown environment keys and platform master secrets (`TUGPT_SECRET_KEY_*`).
- **Positive Supabase URL Validation:** Enforces positive HTTPS URL format, rejecting production project ref `rbiumegrwtavmljxbknp`.

### 4.4 Container Cgroup Limits & Network Governance
- Services enforce strict cgroup CPU, Memory, and PIDs limits (e.g., `web`: 2.0 vCPUs, 2 GiB RAM, 100 PIDs).
- Containers run as unprivileged users with `cap_drop: [ALL]` and `no-new-privileges: true`.
- Staging web binds strictly to loopback `127.0.0.1:3002:3000`.

---

## 5. Consequences

### Positive
- Strict separation between administrative host operations and developer artifact builds.
- Complete hardware and network isolation for GPU media operations.
- Fail-closed deployment automation preventing credential leakages or improper image tags.
- Verified off-host CI smoke integration tests proving real application boundaries and tenant isolation.

### Negative
- All host deployments require administrator execution.
- No direct developer debugging on live GPU hardware.

---

## 6. Verification & Evidence Ledger

| Item | Scope | Status | Evidence / Notes |
| :--- | :--- | :--- | :--- |
| TypeScript Typecheck | Off-Host | **VERIFIED** | `pnpm typecheck` passes all monorepo packages cleanly. |
| Monorepo Linting | Off-Host | **VERIFIED** | `pnpm lint` passes with zero lint errors. |
| Preflight & Launcher Bounds | Off-Host | **VERIFIED** | `staging-deployment-preflight.test.ts` passes 30/30 tests (schema v1.0.0, allowlists, root UID 0, symlinks/perms). |
| Staging Integration Smoke | Off-Host | **VERIFIED** | `staging-functional-smoke.test.ts` passes 6/6 tests (auth session, 403 tenant denial, cgroups, loopback isolation). |
| Architectural Guards & Inventories | Off-Host | **VERIFIED** | Non-test scanner helpers track inventories and traversal errors cleanly across platform slashes. |