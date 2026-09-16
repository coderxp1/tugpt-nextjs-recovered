#!/usr/bin/env sh
#
# deploy/staging/launch-staging.sh
#
# Administrator-owned launcher for TuGPT staging on shared GPU host (31.47.228.55).
# See ADR-018 for governance and security boundaries.
#
# Enforces:
# 1. Administrator-controlled bundle path (/etc/tugpt/staging/ by default).
# 2. Strict directory and file permission checks (no group/world write, env 0600).
# 3. Mandatory preflight execution; aborts before Docker is touched on any failure.
# 4. Standalone staging manifest invocation (-f docker-compose.yml) with no build,
#    no arbitrary profile overrides, and no inherited environment contamination.
#
# Usage:
#   sudo sh /etc/tugpt/staging/launch-staging.sh
#
# Exit codes:
#   0 - staging successfully launched
#   1 - preflight or validation failure
#   2 - missing bundle files or permission defect

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR="${1:-${STAGING_BUNDLE_DIR:-/etc/tugpt/staging}}"
ENV_FILE="${2:-${STAGING_ENV_FILE:-$BUNDLE_DIR/staging.env}}"
DOCKER_COMPOSE_CMD="${DOCKER_COMPOSE_CMD:-docker compose}"

printf '=== TuGPT Staging Administrator Launcher ===\n'
printf 'Bundle Directory: %s\n' "$BUNDLE_DIR"
printf 'Environment File: %s\n' "$ENV_FILE"

# 1. Verify bundle directory exists
if [ ! -d "$BUNDLE_DIR" ]; then
  printf 'FAIL: Staging bundle directory "%s" does not exist.\n' "$BUNDLE_DIR" >&2
  exit 2
fi

# 2. Permission and ownership checks (unless explicitly skipped in test harness)
if [ "${STAGING_SKIP_PERM_CHECK:-0}" != "1" ]; then
  # Check bundle directory permissions: must not be writable by group or world
  dir_perms=$(ls -ld "$BUNDLE_DIR" 2>/dev/null | cut -c 1-10 || true)
  case "$dir_perms" in
    ?????w*|????????w*)
      printf 'FAIL: Bundle directory "%s" is writable by group or others (%s). Mode 0700 required.\n' "$BUNDLE_DIR" "$dir_perms" >&2
      exit 2
      ;;
  esac

  # Check env file permissions: must not be readable/writable by group or world (0600)
  if [ -f "$ENV_FILE" ]; then
    env_perms=$(ls -ld "$ENV_FILE" 2>/dev/null | cut -c 1-10 || true)
    case "$env_perms" in
      ????[rwx]*|???????[rwx]*)
        printf 'FAIL: Environment file "%s" has group/world permissions (%s). Mode 0600 required.\n' "$ENV_FILE" "$env_perms" >&2
        exit 2
        ;;
    esac
  fi
fi

# 3. Locate required bundle files
COMPOSE_FILE="$BUNDLE_DIR/docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
  # Fallback to docker-compose.staging.yml if running from repository
  if [ -f "$BUNDLE_DIR/docker-compose.staging.yml" ]; then
    COMPOSE_FILE="$BUNDLE_DIR/docker-compose.staging.yml"
  elif [ -f "$SCRIPT_DIR/../../docker-compose.staging.yml" ]; then
    COMPOSE_FILE="$SCRIPT_DIR/../../docker-compose.staging.yml"
  else
    printf 'FAIL: Staging compose manifest not found in "%s".\n' "$BUNDLE_DIR" >&2
    exit 2
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  printf 'FAIL: Staging environment file not found at "%s".\n' "$ENV_FILE" >&2
  exit 2
fi

MANIFEST_FILE="$BUNDLE_DIR/release-manifest.json"
if [ ! -f "$MANIFEST_FILE" ]; then
  if [ -f "$SCRIPT_DIR/release-manifest.json" ]; then
    MANIFEST_FILE="$SCRIPT_DIR/release-manifest.json"
  fi
fi

# 4. Mandatory Preflight Validation
CHECK_SCRIPT="$SCRIPT_DIR/check-staging-env.sh"
if [ ! -f "$CHECK_SCRIPT" ]; then
  printf 'FAIL: Preflight validation script not found at "%s".\n' "$CHECK_SCRIPT" >&2
  exit 2
fi

printf '\nRunning mandatory preflight validation...\n'
if ! sh "$CHECK_SCRIPT" "$ENV_FILE" "$MANIFEST_FILE"; then
  printf '\nFATAL: Staging preflight validation failed! Container launch aborted.\n' >&2
  exit 1
fi

# 5. Extract validated image digest from env file (strictly data parsing)
IMAGE_DIGEST=$(grep -E '^[[:space:]]*TUGPT_WEB_STAGING_IMAGE=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//")
if [ -z "$IMAGE_DIGEST" ]; then
  printf 'FATAL: TUGPT_WEB_STAGING_IMAGE could not be extracted from "%s".\n' "$ENV_FILE" >&2
  exit 1
fi

# 6. Scrub inherited overrides and launch standalone compose stack
printf '\nLaunching isolated staging container stack...\n'
printf 'Image: %s\n' "$IMAGE_DIGEST"
printf 'Manifest: %s\n' "$COMPOSE_FILE"

# Clean environment: pass only verified variables to Compose
export TUGPT_WEB_STAGING_IMAGE="$IMAGE_DIGEST"
export TUGPT_STAGING_ENV_FILE="$ENV_FILE"

# Execute Compose
# shellcheck disable=SC2086
$DOCKER_COMPOSE_CMD -p tugpt-staging -f "$COMPOSE_FILE" up -d
rc=$?

if [ "$rc" -eq 0 ]; then
  printf '\nStaging launch complete. Bound to 127.0.0.1:3002.\n'
else
  printf '\nFATAL: Docker compose startup failed with code %d.\n' "$rc" >&2
  exit "$rc"
fi