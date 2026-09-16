# ADR-018: Shared GPU Host Isolation, Resource Governance, and Staging Rehearsal

## Status
Proposed

**Date:** 2026-09-15  
**Deciders:** Klaus Hoffmann, TuGPT Technical Review, TuGPT Infrastructure Team, Antigravity Development Team  
**Consulted:** ADR-006, ADR-010, ADR-013, ADR-014, ADR-015  

---

## 1. Context and Problem Statement

TuGPT is preparing for staging rehearsal and cold recovery on a shared GPU host at `31.47.228.55` (`FINZIA-GPU-01`). The host is a multi-tenant environment with the following **reported operator telemetries**:
- **Compute & OS:** Ubuntu 22.04 LTS (kernel 5.15.0-25-generic), 12 vCPUs, 125 GiB system RAM, 2.0 TB storage (1.8 TB free on `/dev/sda3`) [reported].
- **GPU Subsystem:** 1x NVIDIA RTX Pro 6000 Blackwell DC-48Q vGPU profile (48 GB / 49,152 MiB VRAM), driver `580.82.07`, host CUDA 13.0 [reported]. Note: Container CUDA runtimes are decoupled from host driver CUDA.
- **Active Co-located Workload ("The Infected App"):** Docker Compose service `comfyui` (image `infected/comfyui:local` under `/srv/ai`), bound to loopback `127.0.0.1:8188`, with a **reported dynamic allocation of ~21,771 MiB VRAM** (~44% of vGPU capacity). This represents active resident memory observed during discovery rather than a hardware-enforced reservation.
- **Existing Model Assets:** Pre-installed weights under `/srv/ai/models/` (WAN 2.1 diffusion models, text encoders, VAE) shared with `/srv/ai/workflows/cinedrama` (user `cinedrama-agent`) and `infected`.
- **Infrastructure Status:** The historical production VPS (`212.227.44.13`) has been decommissioned and will not be used. TuGPT is currently offline publicly, with zero live queue consumers. There is no old host to roll back to; this deployment represents a **cold recovery and staging re-deployment**.

### The Challenges & Shared-Host Realities:
1. **Host Co-existence:** We must protect the co-located ComfyUI workload and preserve CineDrama assets pending an approved deletion manifest.
2. **GPU VRAM Contention:** Container boundaries do not enforce vGPU memory partitioning. An uncoordinated TuGPT GPU workload could trigger an out-of-memory (OOM) event on the protected ComfyUI process.
3. **Shared-Host Residual Risks:** Because TuGPT shares the underlying host, complete hardware isolation is not achievable without full VM separation. Residual risks include:
   - Shared Linux kernel (5.15.0-25-generic) attack surface and container escape vectors.
   - Disk I/O bandwidth and IOPS contention on the single shared NVMe filesystem `/dev/sda3`.
   - Network socket and bandwidth contention on the single physical interface `ens18`.
   - CPU and memory noisy-neighbor effects under transient high loads.
4. **Queue Invariant:** TuGPT enforces a strict operational rule of **at most one authorized consumer per existing production queue** (`whatsapp_inbound`, `draft_generation`, `transcription`). Zero active consumers during cold recovery and staging rehearsal is completely safe, legal, and required. Starting unauthorized staging workers against production queues or credentials would corrupt message processing.
5. **Database Identity:** Staging must connect to an independent staging Supabase project (never the production project `rbiumegrwtavmljxbknp`).

---

## 2. Decision Drivers

- **Security & Project Isolation:** TuGPT must operate strictly within its own isolated filesystem, network, and process boundaries.
- **Protected Service Safety:** Zero modifications, signals, mounts, or network access to `/srv/ai` or `infected/comfyui:local`.
- **Operational Verifiability:** Every security constraint and environment invariant must be testable before runtime execution.
- **Clean Staging Rehearsal:** Staging must use separate credentials, separate queues, independent database project identity, and zero production worker execution.
- **Privileged Deployment Boundary:** Developer accounts have no sudo, no Docker socket access, and no live interactive host shell during staging.

---

## 3. Considered Options

* **Option A (Shared Host / Monolithic Access):** Grant developer Docker group access and mount `/srv/ai/models` directly into TuGPT.  
  * *Rejected:* Defeats non-root boundaries, risks host compromise, and endangers ComfyUI stability.
* **Option B (Immediate On-Host GPU Deployment):** Deploy media generation workers directly using remaining ~27.3 GB VRAM.  
  * *Rejected:* Without shared scheduling or hardware vGPU slicing, concurrent inference risks unrecoverable OOM for the protected workload.
* **Option C (Hardened Namespace Isolation + Staging Rehearsal + GPU Moratorium - Selected):** Enforce administrator-managed deployment bundles, strictly isolated Compose namespaces, runtime-only container manifests, container resource limits, separate staging project credentials, and a total moratorium on GPU workloads until an approved scheduling coordinator is established.

---

## 4. Decision

### 4.1 Developer Account & SSH Access Architecture (DEFERRED)
1. **Developer Host Shell Access Status:** **DEFERRED / NOT AUTHORIZED**. Direct interactive developer shell access (`tugpt-dev`) on `31.47.228.55` is deferred. Staging rehearsal will be operated directly by an authorized host administrator to maintain an audit trail and simplify host security.
2. **Access Control Clarifications (for future reference):**
   - **Account Revocation vs. Locking:** `usermod -L` only modifies `/etc/shadow` password fields and does NOT invalidate OpenSSH public keys. True SSH key revocation requires removing/clearing public keys from `~/.ssh/authorized_keys`, account expiration via `chage -E 0`, or setting the login shell to `/usr/sbin/nologin`.
   - **Active Session and Forwarding Limits:** Setting `/usr/sbin/nologin` or locking passwords prevents *new* interactive shell sessions, but does NOT terminate already-established, active SSH connections, nor does it block non-shell capabilities such as TCP port forwarding (`ssh -N -L ...`) or SFTP subsystem sessions if active. Comprehensive revocation requires terminating active processes via `pkill -u <user>`, explicitly disabling port forwarding (`AllowTcpForwarding no`, `PermitOpen none`), and disabling agent forwarding (`AllowAgentForwarding no`) in `sshd_config` match blocks.
   - **Loopback & Firewall Isolation:** A single `iptables -A OUTPUT -m owner --uid-owner tugpt-dev -d 127.0.0.1 -p tcp --dport 8188 -j REJECT` rule is incomplete: it does not cover IPv6 (`::1`), alias loopback addresses, or bridge networks. True network isolation relies on container network namespaces (custom bridge networks without host networking) and binding protected services strictly to localhost.
   - **SSH IP Restriction:** In OpenSSH `sshd_config`, `Match User Address` applies conditional block overrides. Restricting an account to an approved IP requires pairing with default deny semantics or explicit non-matching blocks.

### 4.2 Filesystem & Path Governance
1. **Directory Allocation:**
   - `/etc/tugpt/staging/` (owned by `root:root`, mode `0700`): Administrator-owned staging deployment bundle containing `docker-compose.yml`, `staging.env` (mode `0600`), and `release-manifest.json`. Developer accounts have zero access to `/etc/tugpt/`.
   - `/var/lib/tugpt/` (mode `0750`): TuGPT persistent runtime storage and temporary job artifacts.
2. **Withdrawal of `render` Group Membership:**
   - `tugpt-dev` will NOT be added to group `render`.
   - Shared model reuse from `/srv/ai/models/` is deferred. Any future weight access will be implemented via administrator-configured, read-only container bind mounts of verified checksummed files.

### 4.3 Privileged Deployment Boundary, Manifest & Network Isolation Policy
- Deployment is executed exclusively by an authorized administrator using an administrator-owned bundle and dedicated launcher:
  ```bash
  # Launch staging stack (executes mandatory preflight before Docker startup)
  sudo sh /etc/tugpt/staging/launch-staging.sh
  ```
- Individual stack lifecycle operations are separated:
  ```bash
  # Start staging stack directly
  docker compose -p tugpt-staging -f /etc/tugpt/staging/docker-compose.yml up -d

  # Stop staging containers (preserves container state and networks)
  docker compose -p tugpt-staging -f /etc/tugpt/staging/docker-compose.yml stop

  # Down staging stack (removes containers and custom networks, preserves named volumes)
  docker compose -p tugpt-staging -f /etc/tugpt/staging/docker-compose.yml down

  # Full teardown with volume removal (explicit, separate choice)
  docker compose -p tugpt-staging -f /etc/tugpt/staging/docker-compose.yml down --volumes
  ```
- The staging manifest (`docker-compose.staging.yml`) is **runtime-only**: it contains no `build:` sections and requires an immutable image with an approved `@sha256:` digest (no mutable tag fallback):
  ```yaml
  image: "${TUGPT_WEB_STAGING_IMAGE:?TUGPT_WEB_STAGING_IMAGE with approved @sha256 digest is required}"
  ```
- **Staging Container Network Policy:**
  - The `web` service runs attached strictly to an isolated Docker bridge network (`tugpt_staging_net`). Host networking (`network_mode: host`) is strictly prohibited.
  - **Loopback Isolation:** The loopback address `127.0.0.1` inside the container refers strictly to the container's private network namespace. Requests from inside the container to `127.0.0.1:8188` (ComfyUI) or `127.0.0.1:3001` (production) fail with connection refused, isolating host loopback services.
  - **Port Publishing:** Staging web publishes port `3002:3000` bound strictly to host loopback `127.0.0.1:3002`. Public exposure on `0.0.0.0` is prevented.
  - **Outbound Traffic:** Container outbound traffic to external staging infrastructure (e.g. `https://staging.example.supabase.co`) routes through the Docker bridge gateway and host NAT, while host loopback services remain unreachable.

### 4.4 Resource Governance & Cgroup Quotas
All TuGPT services in Docker Compose must define strict resource limits to protect host stability:

| Service | CPU Limit | Memory Limit | PIDs Limit | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `web` | 2.0 vCPUs | 2 GiB | 100 | Next.js 16 standalone server |
| `whatsapp-worker` | 1.0 vCPUs | 1 GiB | 50 | Inbound message processing (excluded in staging) |
| `draft-worker` | 2.0 vCPUs | 2 GiB | 50 | Langdock API calling loop (excluded in staging) |
| `transcription-worker` | 2.0 vCPUs | 4 GiB | 100 | Media download & Gladia polling (excluded in staging) |
| Future CPU Exporter (PDF/ZIP) | 2.0 vCPUs | 2 GiB | 50 | Sandboxed rendering, strict timeout |

### 4.5 GPU Moratorium Policy
1. **Zero TuGPT GPU Workloads:** No GPU devices (`deploy.resources.reservations.devices`) are allocated to TuGPT containers in the staging or initial production manifests.
2. **Prerequisites for Future GPU Enablement:**
   - Complete characterization of VRAM usage across models (FLUX.1-schnell, WAN 2.1 1.3B/14B) with explicit quantization, resolution, and offload parameters.
   - Design and implementation of a cross-process admission coordinator or explicit operator-reserved GPU execution window.
   - Administrator verification of vGPU slicing or dynamic memory reservation that guarantees immunity for `infected/comfyui:local`.

### 4.6 Staging Rehearsal & Cold Recovery Strategy
1. **Isolated Staging Environment:**
   - Dedicated Compose project namespace: `-p tugpt-staging`.
   - Dedicated, independent staging Supabase project (never production project ref `rbiumegrwtavmljxbknp`).
   - Staging secrets sourced from `/etc/tugpt/staging/staging.env` (mode `0600`).
   - Preflight validation script `deploy/staging/check-staging-env.sh` runs prior to container launch.
2. **Queue Protection Invariant:**
   - At most one authorized consumer per existing production queue. During staging rehearsal, **all production queue workers remain strictly OFF** (zero consumers in recovery is legal, safe, and required).
   - `docker-compose.staging.yml` omits `whatsapp-worker`, `draft-worker`, and `transcription-worker`.
3. **Secrets & Master Key Hygiene:**
   - `platform_secrets` table holds encrypted credential records.
   - Master key `TUGPT_SECRET_KEY_PLATFORM_V1` and all `TUGPT_SECRET_KEY_*` variables must NEVER be present in staging environment files; verified by preflight automation.

---

## 5. Consequences

### Positive
- Strict cgroup CPU, Memory, and PIDs boundaries protect host stability.
- Staging preflight validation mechanically enforces project isolation and prevents production credential leakage.
- Production queues and database are completely protected from rehearsal interference.
- Container execution runs as unprivileged user (`nextjs:nodejs`, UID 1001) with all Linux capabilities dropped (`cap_drop: [ALL]`).

### Negative / Trade-offs & Shared-Host Residual Risks
- Administrator mediation is required for privileged deployment and staging container lifecycles.
- GPU-backed features remain deferred until scheduling coordination review gates are satisfied.
- Residual shared-host risks remain:
  - Kernel-level shared surface (Ubuntu 22.04 LTS kernel 5.15.0-25-generic).
  - Storage I/O throughput and latency contention on shared NVMe filesystem `/dev/sda3`.
  - Network interface throughput and socket contention on physical NIC `ens18`.

---

## 6. Verification & Evidence Ledger

Verification items are classified into verified off-host gates and deferred host-specific checks:

| Item | Scope | Status | Evidence / Notes |
| :--- | :--- | :--- | :--- |
| TypeScript Typecheck | Off-Host | **VERIFIED** | `turbo typecheck` passes 18/18 packages (exit code 0). |
| Unit & Integration Tests | Off-Host | **VERIFIED** | Vitest passes all 27 worker suites (463 tests) and 23 web suites (386 tests). |
| Staging Manifest Invariants | Off-Host | **VERIFIED** | `staging-deployment-preflight.test.ts` asserts runtime-only, loopback 3002, cap_drop ALL, no GPU. |
| Negative Controls Suite | Off-Host | **VERIFIED** | `path-normalization-negative-controls.test.ts` asserts all 5 architectural guards fail on violating fixtures. |
| Preflight Script Validation | Off-Host | **VERIFIED** | `deploy/staging/check-staging-env.sh` verified against valid and violating synthetic fixtures. |
| Docker Web Image Build | Off-Host | **VERIFIED** | `tugpt-web:staging-test` built cleanly via `apps/web/Dockerfile`. |
| Docker Worker Image Build | Off-Host | **VERIFIED** | `tugpt-worker:staging-test` built cleanly via `apps/worker/Dockerfile`. |
| Developer Host Shell (`tugpt-dev`) | On-Host | **DEFERRED** | Direct developer shell access deferred; staging rehearsal operated by host administrator. |
| Host Loopback Firewall Filtering | On-Host | **NOT YET VERIFIED** | Deferred pending host administrator execution. |
| Live ComfyUI Non-Interference | On-Host | **NOT YET VERIFIED** | Deferred pending host staging deployment. |