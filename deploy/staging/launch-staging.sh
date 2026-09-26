#!/usr/bin/env sh
#
# deploy/staging/launch-staging.sh
#
# Administrator-owned privileged launcher for TuGPT staging on shared GPU host (31.47.228.55).
# See ADR-018 for governance and security boundaries.
#
# Security Enforcements:
# 1. Effective root UID check (must be executed as root, UID 0).
# 2. Fixed canonical path constants in /etc/tugpt/staging (no configurable overrides).
# 3. Strict rejection of symlinks on bundle directory, configuration files, and launcher.
# 4. Verified root ownership (0:0) on all bundle files, bundle directory, and parents.
# 5. Exact permission modes: directory 0700, secret environment and manifests 0600, scripts 0700.
# 6. Mandatory fail-closed preflight execution before any Docker command is touched.
# 7. Clean process execution environment (env -i) with minimal PATH, HOME, and isolated Docker inputs.
# 8. Controlled Docker Compose invocation with --env-file /dev/null to prevent ambient interpolation.
#
# Usage:
#   sudo /etc/tugpt/staging/launch-staging.sh
#
# Exit codes:
#   0 - staging successfully launched
#   1 - preflight or validation failure
#   2 - permission, ownership, symlink, or missing file defect
#   * - Docker compose exit code on execution failure

set -u

BUNDLE_DIR="/etc/tugpt/staging"
ENV_FILE="$BUNDLE_DIR/staging.env"
COMPOSE_FILE="$BUNDLE_DIR/docker-compose.yml"
MANIFEST_FILE="$BUNDLE_DIR/release-manifest.json"
CHECK_SCRIPT="$BUNDLE_DIR/check-staging-env.sh"
DOCKER_BIN="/usr/bin/docker"

printf '=== TuGPT Staging Administrator Launcher ===\n'

# ------------------------------------------------------------------------------
# 1. Effective Root UID Check
# ------------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  printf 'FAIL: Staging launcher must be executed as root (effective UID 0).\n' >&2
  exit 2
fi

# ------------------------------------------------------------------------------
# 2. Verify File Existence & Reject Symlinks
# ------------------------------------------------------------------------------
for p in /etc /etc/tugpt "$BUNDLE_DIR" "$ENV_FILE" "$COMPOSE_FILE" "$MANIFEST_FILE" "$CHECK_SCRIPT" "$0"; do
  if [ -L "$p" ]; then
    printf 'FAIL: Symlink detected at "%s". Symlinks are strictly forbidden in deployment bundle.\n' "$p" >&2
    exit 2
  fi
done

if [ ! -d "$BUNDLE_DIR" ]; then
  printf 'FAIL: Staging bundle directory "%s" does not exist.\n' "$BUNDLE_DIR" >&2
  exit 2
fi

for f in "$ENV_FILE" "$COMPOSE_FILE" "$MANIFEST_FILE" "$CHECK_SCRIPT"; do
  if [ ! -f "$f" ] || [ ! -r "$f" ]; then
    printf 'FAIL: Required bundle file "%s" is missing or unreadable.\n' "$f" >&2
    exit 2
  fi
done

if [ ! -x "$DOCKER_BIN" ]; then
  printf 'FAIL: Docker executable not found at "%s".\n' "$DOCKER_BIN" >&2
  exit 2
fi

# ------------------------------------------------------------------------------
# 3. Ownership and Exact Mode Enforcements
# ------------------------------------------------------------------------------
check_owner() {
  target="$1"
  owner=$(stat -c "%u:%g" "$target" 2>/dev/null || stat -f "%u:%g" "$target" 2>/dev/null || echo "unknown")
  if [ "$owner" != "0:0" ]; then
    printf 'FAIL: Target "%s" is owned by %s. Must be owned by root:root (0:0).\n' "$target" "$owner" >&2
    exit 2
  fi
}

check_exact_mode() {
  target="$1"
  expected="$2"
  mode=$(stat -c "%a" "$target" 2>/dev/null || stat -f "%OLp" "$target" 2>/dev/null || echo "unknown")
  # Strip leading zero if present for uniform 3-digit comparison
  mode=$(printf '%s' "$mode" | sed 's/^0*//')
  expected_trimmed=$(printf '%s' "$expected" | sed 's/^0*//')
  if [ "$mode" != "$expected_trimmed" ]; then
    printf 'FAIL: Target "%s" has mode %s. Mode %s required.\n' "$target" "$mode" "$expected" >&2
    exit 2
  fi
}

check_parent_safe() {
  dir="$1"
  check_owner "$dir"
  mode=$(stat -c "%a" "$dir" 2>/dev/null || stat -f "%OLp" "$dir" 2>/dev/null || echo "unknown")
  case "$mode" in
    *[2367]?|*[2367])
      printf 'FAIL: Parent directory "%s" is group- or world-writable (mode %s).\n' "$dir" "$mode" >&2
      exit 2
      ;;
  esac
}

# Check parent directory trust
check_parent_safe "/etc"
check_parent_safe "/etc/tugpt"

# Check bundle directory: must be 0700, root:root
check_owner "$BUNDLE_DIR"
check_exact_mode "$BUNDLE_DIR" "700"

# Check environment file: must be 0600, root:root
check_owner "$ENV_FILE"
check_exact_mode "$ENV_FILE" "600"

# Check manifest file: must be 0600, root:root
check_owner "$MANIFEST_FILE"
check_exact_mode "$MANIFEST_FILE" "600"

# Check compose file: must be 0600, root:root
check_owner "$COMPOSE_FILE"
check_exact_mode "$COMPOSE_FILE" "600"

# Check preflight check script: must be 0700, root:root
check_owner "$CHECK_SCRIPT"
check_exact_mode "$CHECK_SCRIPT" "700"

# Check launcher script itself: must be root:root, 0700
check_owner "$0"
check_exact_mode "$0" "700"

# ------------------------------------------------------------------------------
# 4. Mandatory Preflight Validation
# ------------------------------------------------------------------------------
printf '\nExecuting mandatory preflight validation...\n'
if ! sh "$CHECK_SCRIPT" "$ENV_FILE" "$MANIFEST_FILE"; then
  printf '\nFATAL: Preflight validation failed! Container startup aborted before Docker invocation.\n' >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 5. Extract Validated Image Reference (Data-Only)
# ------------------------------------------------------------------------------
IMAGE_REF=$(grep -E '^[[:space:]]*TUGPT_WEB_STAGING_IMAGE=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//")
if [ -z "$IMAGE_REF" ]; then
  printf 'FATAL: TUGPT_WEB_STAGING_IMAGE could not be parsed from "%s".\n' "$ENV_FILE" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 6. Execute Docker Compose with Scrubbed Environment (env -i)
# ------------------------------------------------------------------------------
printf '\nRequesting staging container startup...\n'
printf 'Image: %s\n' "$IMAGE_REF"
printf 'Manifest: %s\n' "$COMPOSE_FILE"

# Clean execution environment: pass only controlled PATH, HOME, and approved image
env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="/root" \
  TUGPT_WEB_STAGING_IMAGE="$IMAGE_REF" \
  "$DOCKER_BIN" compose \
  --project-directory "$BUNDLE_DIR" \
  --project-name tugpt-staging \
  --file "$COMPOSE_FILE" \
  --env-file /dev/null \
  up -d

rc=$?

if [ "$rc" -ne 0 ]; then
  printf '\nFATAL: Docker compose startup failed with exit code %d.\n' "$rc" >&2
  exit "$rc"
fi

printf '\nStaging container startup requested successfully.\n'
printf 'Verification: Administrator must inspect container status and health:\n'
printf '  docker compose -p tugpt-staging -f %s ps\n' "$COMPOSE_FILE"
printf '  docker inspect tugpt-staging-web-1\n'
exit 0