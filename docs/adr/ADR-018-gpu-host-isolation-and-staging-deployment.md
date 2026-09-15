# ADR-018: Shared GPU Host Isolation, Resource Governance, and Staging Rehearsal

**Status:** PROPOSED  
**Date:** 2026-09-15  
**Deciders:** Klaus Hoffmann, TuGPT Technical Review, TuGPT Infrastructure Team, Antigravity Development Team  
**Consulted:** ADR-006, ADR-010, ADR-013, ADR-014, ADR-015  

---

## 1. Context and Problem Statement

TuGPT is migrating to a shared GPU host at `31.47.228.55` (`FINZIA-GPU-01`). The host is a multi-tenant environment equipped with:
- **Compute & OS:** Ubuntu 22.04 LTS (kernel 5.15.0-25-generic), 12 vCPUs, 125 GiB system RAM, 2.0 TB storage (1.8 TB free on `/dev/sda3`).
- **GPU Subsystem:** 1x NVIDIA RTX Pro 6000 Blackwell DC-48Q vGPU profile (48 GB / 49,152 MiB VRAM), driver `580.82.07`, host CUDA 13.0.
- **Active Co-located Workload ("The Infected App"):** Docker Compose service `comfyui` (image `infected/comfyui:local` under `/srv/ai`), bound to loopback `127.0.0.1:8188`, actively reserving **21,771 MiB VRAM** (~44% of available vGPU VRAM).
- **Existing Model Assets:** Pre-installed weights under `/srv/ai/models/` (WAN 2.1 diffusion models, text encoders, VAE) shared with `/srv/ai/workflows/cinedrama` (user `cinedrama-agent`) and `infected`.
- **Infrastructure Status:** The historical production VPS (`212.227.44.13`) has been decommissioned and will not be used. TuGPT is currently offline publicly, with zero queue consumers running. There is no live old host to roll back to; this deployment is a **cold recovery and staging re-deployment**.

### The Challenges:
1. **Host Co-existence:** We must guarantee absolute zero interference with the protected ComfyUI workload and preserve CineDrama assets pending an approved deletion manifest.
2. **GPU VRAM Contention:** Container isolation does not enforce GPU VRAM partitioning. An uncoordinated TuGPT GPU job could trigger an out-of-memory (OOM) event on the protected ComfyUI process.
3. **Loopback Service Isolation:** A standard non-root user shell on Linux can query loopback `127.0.0.1:8188`. Restricting SSH port forwarding alone is insufficient.
4. **Queue Invariant:** TuGPT enforces a strict operational rule of exactly **one consumer per queue** (`whatsapp_inbound`, `draft_generation`, `transcription`). Starting staging workers against production queues or credentials would violate data integrity.

---

## 2. Decision Drivers

- **Security & Project Isolation:** TuGPT must operate strictly within its own filesystem, network, and process boundaries.
- **Protected Service Safety:** Zero modifications, signals, mounts, or network access to `/srv/ai` or `infected/comfyui:local`.
- **Operational Verifiability:** Every security and isolation boundary must be machine-testable before deployment.
- **Clean Staging Rehearsal:** Staging must use separate credentials, separate queues, and zero production worker execution.
- **Zero Host Privilege Escalation:** Developer SSH accounts must have no sudo, no Docker socket access, and no docker group membership.

---

## 3. Considered Options

* **Option A (Shared Host / Monolithic Access):** Grant developer Docker group access and mount `/srv/ai/models` directly into TuGPT.  
  * *Rejected:* Violates project isolation, defeats non-root security boundaries, and risks host compromise or ComfyUI disruption.
* **Option B (Immediate On-Host GPU Deployment):** Deploy media generation workers directly using available ~27.3 GB VRAM.  
  * *Rejected:* Without shared scheduling or hard vGPU partitioning, concurrent inference creates unacceptable OOM risk for the protected app.
* **Option C (Hardened Namespace Isolation + Staging Rehearsal + GPU Moratorium - Selected):** Enforce OS-level account and network restrictions, strictly isolated Compose namespaces, container resource limits, separate staging credentials, and a total moratorium on GPU workloads until an approved scheduling coordinator is established.

---

## 4. Decision

### 4.1 Developer Account & SSH Access Architecture
1. **Dedicated Developer Identity:** Account `tugpt-dev` (allocated safely with dynamic UID check >= 1002).
2. **Access Restrictions:**
   - Public key authentication only; `PasswordAuthentication no` and `KbdInteractiveAuthentication no` enforced.
   - Enforce source IP restriction in `sshd_config`: `Match User tugpt-dev Address 187.40.54.128/32`.
   - Restrict SSH capabilities:
     ```text
     Match User tugpt-dev
         AllowTcpForwarding no
         X11Forwarding no
         AllowAgentForwarding no
         PermitTunnel no
     ```
   - Account expiration enforced via OS account control: `chage -E 2026-09-29 tugpt-dev`.
   - Revocation procedure: `usermod -L tugpt-dev && pkill -u tugpt-dev`.
   - Authorized keys file managed exclusively by root under `/etc/ssh/authorized_keys.d/tugpt-dev` (mode `0644`, owned by `root:root`); developer home directory has no write permission to SSH authorized keys.
3. **Loopback & Network Isolation:**
   - Reject developer access to the protected ComfyUI service on `127.0.0.1:8188`.
   - Administrator enforces an iptables/nftables UID filter:
     ```bash
     iptables -A OUTPUT -m owner --uid-owner tugpt-dev -d 127.0.0.1 -p tcp --dport 8188 -j REJECT
     ```
   - All TuGPT containers run on dedicated bridge networks (`tugpt_net`), with no host networking.

### 4.2 Filesystem & Path Governance
1. **Directory Allocation:**
   - `/opt/tugpt/` (owned by `tugpt-dev:tugpt-dev`, mode `0755`): Git repository checkout, application source, and Compose manifests.
   - `/etc/tugpt/` (owned by `root:root`, mode `0700`): Production and staging environment files (`web.env`, `worker.env`, `staging.env`). Inaccessible to developer accounts (`chmod 0600`).
   - `/var/lib/tugpt/` (owned by `tugpt-dev:tugpt-dev`, mode `0750`): TuGPT persistent storage, local caches, and temporary job artifacts.
2. **Withdrawal of `render` Group Membership:**
   - As directed by review, `tugpt-dev` will NOT be added to group `render`.
   - Shared model reuse from `/srv/ai/models/` is deferred. Any future weight access will be implemented via administrator-configured, read-only container bind mounts of verified checksummed files.

### 4.3 Privileged Deployment Boundary
- The developer account has **no Docker socket access** and **no sudo privileges**.
- Deployment is executed exclusively through an administrator-owned mechanism:
  - Administrator reviews the Compose definition, Dockerfiles, and image digests.
  - Staging stack launched via administrator-owned systemd unit or deployment script:
    ```bash
    docker compose -p tugpt-staging -f /opt/tugpt/docker-compose.staging.yml up -d
    ```
  - Developer cannot alter running container configurations or mount arbitrary host paths.

### 4.4 Resource Governance & Cgroup Quotas
All TuGPT services in Docker Compose must define strict resource limits to protect host stability and prevent starvation:

| Service | CPU Limit | Memory Limit | PIDs Limit | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `web` | 2.0 vCPUs | 2 GiB | 100 | Next.js 16 standalone server |
| `whatsapp-worker` | 1.0 vCPUs | 1 GiB | 50 | Inbound message processing |
| `draft-worker` | 2.0 vCPUs | 2 GiB | 50 | Langdock API calling loop |
| `transcription-worker` | 2.0 vCPUs | 4 GiB | 100 | Media download & Gladia polling |
| Future CPU Exporter (PDF/ZIP) | 2.0 vCPUs | 2 GiB | 50 | Sandboxed rendering, strict timeout |

### 4.5 GPU Moratorium Policy
1. **Zero TuGPT GPU Workloads:** No GPU devices (`deploy.resources.reservations.devices`) are allocated to TuGPT containers in the staging or initial production manifests.
2. **Prerequisites for Future GPU Enablement:**
   - Complete characterization of VRAM usage across models (FLUX.1-schnell, WAN 2.1 1.3B/14B) with explicit quantization, resolution, and offload parameters.
   - Design and implementation of a cross-process admission coordinator or explicit operator-reserved GPU execution window.
   - Administrator verification of vGPU slicing or dynamic memory reservation that guarantees immunity for `infected/comfyui:local`.

### 4.6 Staging Rehearsal & Cold Recovery Strategy
1. **Isolated Staging Environment:**
   - Dedicated Compose project: `-p tugpt-staging`.
   - Separate staging database instance or schema with independent staging PGMQ queues.
   - Staging secrets sourced from `/etc/tugpt/staging.env`.
2. **Queue Protection Invariant:**
   - During staging rehearsal, **all production queue workers remain strictly OFF**.
   - `docker-compose.staging.yml` omits `whatsapp-worker`, `draft-worker`, and `transcription-worker` or runs them only against isolated test queues.
3. **Secrets & Master Key Recovery:**
   - `platform_secrets` table holds encrypted credential records.
   - Master key `TUGPT_SECRET_KEY_PLATFORM_V1` is restored by the administrator into `/etc/tugpt/worker.env` from secure offline password vaults. The developer never receives access to this key.

---

## 5. Consequences

### Positive
- Absolute non-interference guarantee for the protected ComfyUI application.
- Immune to accidental loopback probing or privilege escalation from the developer account.
- Predictable, bounded CPU and memory consumption across all TuGPT containers.
- Rehearsal on staging cannot contaminate production queues or trigger duplicate message handling.

### Negative / Trade-offs
- On-host testing by developer requires administrator mediation for privileged container lifecycle actions.
- GPU-backed media features remain deferred until the scheduling and isolation review gates are passed.

---

## 6. Verification & Automated Testing Plan

Before any staging container start:
1. **Access Test Suite:**
   - Verify `ssh tugpt-dev@31.47.228.55` succeeds from approved IP `187.40.54.128` and fails from unapproved IPs.
   - Verify `curl -m 2 http://127.0.0.1:8188` from `tugpt-dev` shell is REJECTED by firewall.
   - Verify `docker ps` from `tugpt-dev` returns `permission denied`.
   - Verify `sudo` execution returns `sudo: a password is required` / user not in sudoers.
   - Verify `/srv/ai/workflows/infected` and `/srv/ai/workflows/cinedrama` return `Permission denied`.
2. **Static CI Gate Validation:**
   - `pnpm turbo run lint typecheck test build` passing 100% on `feat/gpu-host-isolation-staging`.
