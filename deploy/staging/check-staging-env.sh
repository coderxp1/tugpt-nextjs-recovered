#!/usr/bin/env sh
#
# deploy/staging/check-staging-env.sh
#
# Preflight validation for staging environment before container startup.
# Verifies environment configuration as DATA against isolation invariants:
#
# 1. TUGPT_ENVIRONMENT must be strictly 'staging'.
# 2. Configuration is parsed strictly as data (no shell evaluation, no command injection).
# 3. NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS URL matching approved staging identity.
# 4. NEXT_PUBLIC_SUPABASE_ANON_KEY must be set and non-empty.
# 5. TUGPT_WEB_STAGING_IMAGE must specify an approved repository + @sha256: digest.
# 6. Build-time NEXT_PUBLIC_* settings must match runtime staging identity.
# 7. All TUGPT_SECRET_KEY_* variables are strictly FORBIDDEN in staging.
# 8. All production credentials and references are strictly FORBIDDEN.
#
# Usage:
#   sh deploy/staging/check-staging-env.sh [path/to/staging.env] [path/to/release-manifest.json]
#
# Exit codes:
#   0 - all checks passed
#   1 - one or more validation errors
#   2 - configuration or manifest file could not be read

set -u

ENV_FILE="${1:-}"
MANIFEST_FILE="${2:-}"

HERE=$(cd "$(dirname "$0")" && pwd)
if [ -z "$MANIFEST_FILE" ]; then
  if [ -f "$HERE/release-manifest.json" ]; then
    MANIFEST_FILE="$HERE/release-manifest.json"
  elif [ -f "/etc/tugpt/staging/release-manifest.json" ]; then
    MANIFEST_FILE="/etc/tugpt/staging/release-manifest.json"
  fi
fi

errors=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  errors=$((errors + 1))
}

# Values parsed from ENV_FILE or environment
TUGPT_ENV=""
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
IMAGE_REF=""

# Track seen keys for duplicate key rejection
SEEN_KEYS=" "

parse_env_file() {
  file="$1"
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    printf 'FAIL: Configuration file "%s" is not readable or does not exist.\n' "$file" >&2
    exit 2
  fi

  # Read file line-by-line strictly as data
  line_num=0
  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    line_num=$((line_num + 1))
    # Strip leading and trailing whitespace
    line=$(printf '%s' "$raw_line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    # Skip blank lines and full-line comments
    case "$line" in
      ""|\#*) continue ;;
    esac

    # Validate KEY=VALUE format: key must be alphanumeric + underscore
    case "$line" in
      [A-Za-z_][A-Za-z0-9_]*=*)
        key=$(printf '%s' "$line" | cut -d= -f1)
        val=$(printf '%s' "$line" | cut -d= -f2-)
        ;;
      *)
        fail "Invalid configuration line $line_num in $file: '$line' (must be KEY=VALUE)"
        continue
        ;;
    esac

    # Check for duplicate keys
    case "$SEEN_KEYS" in
      *" $key "*)
        fail "Duplicate key '$key' detected at line $line_num in $file"
        ;;
      *)
        SEEN_KEYS="$SEEN_KEYS$key "
        ;;
    esac

    # Reject shell command substitution or code injection in values
    case "$val" in
      *\$\(*|*\`*|*\;*|*\&\&*|*\|\|*)
        fail "Forbidden shell command substitution syntax detected in key '$key' at line $line_num"
        ;;
    esac

    # Strip optional surrounding single or double quotes
    case "$val" in
      \'*\'|\"*\")
        val=$(printf '%s' "$val" | sed -e "s/^['\"]//" -e "s/['\"]$//")
        ;;
    esac

    # Check for any TUGPT_SECRET_KEY_* (reject regardless of suffix or empty value)
    case "$key" in
      TUGPT_SECRET_KEY_*)
        fail "Prohibited key '$key' present in configuration! All platform master secrets are forbidden in staging."
        ;;
    esac

    # Assign recognized keys
    case "$key" in
      TUGPT_ENVIRONMENT) TUGPT_ENV="$val" ;;
      NEXT_PUBLIC_SUPABASE_URL) SUPABASE_URL="$val" ;;
      NEXT_PUBLIC_SUPABASE_ANON_KEY) SUPABASE_ANON_KEY="$val" ;;
      TUGPT_WEB_STAGING_IMAGE) IMAGE_REF="$val" ;;
    esac
  done < "$file"
}

if [ -n "$ENV_FILE" ]; then
  parse_env_file "$ENV_FILE"
else
  # Use current environment if no file specified
  TUGPT_ENV="${TUGPT_ENVIRONMENT:-}"
  SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
  SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"
  IMAGE_REF="${TUGPT_WEB_STAGING_IMAGE:-}"

  # Check ambient environment for any TUGPT_SECRET_KEY_*
  for var in $(env 2>/dev/null | grep -E '^TUGPT_SECRET_KEY_' | cut -d= -f1 || true); do
    fail "Prohibited environment variable '$var' present in ambient environment!"
  done
fi

# 1. Validate TUGPT_ENVIRONMENT
if [ "$TUGPT_ENV" = "staging" ]; then
  pass "TUGPT_ENVIRONMENT is 'staging'"
else
  fail "TUGPT_ENVIRONMENT must be 'staging' (current: '$TUGPT_ENV')"
fi

# 2. Positive Staging Supabase URL Validation
if [ -z "$SUPABASE_URL" ]; then
  fail "NEXT_PUBLIC_SUPABASE_URL is missing or empty"
else
  # Enforce exact HTTPS URL format without userinfo, ports, or trailing path
  case "$SUPABASE_URL" in
    https://[a-zA-Z0-9.-]*.supabase.co|https://[a-zA-Z0-9.-]*.supabase.in)
      host_part=$(printf '%s' "$SUPABASE_URL" | sed 's|^https://||')
      case "$host_part" in
        *@*|*:*|*/*|*\?*|*\#*)
          fail "NEXT_PUBLIC_SUPABASE_URL contains invalid userinfo, port, path, or query ($SUPABASE_URL)"
          ;;
        *)
          # Ensure it does NOT match production project ref
          case "$SUPABASE_URL" in
            *rbiumegrwtavmljxbknp*)
              fail "NEXT_PUBLIC_SUPABASE_URL targets production project ref (rbiumegrwtavmljxbknp)!"
              ;;
            *)
              pass "NEXT_PUBLIC_SUPABASE_URL is a valid staging Supabase URL"
              ;;
          esac
          ;;
      esac
      ;;
    *)
      fail "NEXT_PUBLIC_SUPABASE_URL is not an approved Supabase HTTPS URL: '$SUPABASE_URL'"
      ;;
  esac
fi

# 3. Validate NEXT_PUBLIC_SUPABASE_ANON_KEY
if [ -z "$SUPABASE_ANON_KEY" ]; then
  fail "NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty"
else
  pass "NEXT_PUBLIC_SUPABASE_ANON_KEY is defined"
fi

# 4. Validate Release Manifest and Immutable Image Digest
if [ -n "$MANIFEST_FILE" ] && [ -f "$MANIFEST_FILE" ]; then
  # Parse manifest fields using sed/grep (no jq requirement for minimal POSIX sh)
  APPROVED_DIGEST=$(grep -E '"approvedDigest"' "$MANIFEST_FILE" | head -1 | sed -e 's/.*"approvedDigest"[[:space:]]*:[[:space:]]*"//' -e 's/".*//')
  APPROVED_URL=$(grep -E '"approvedStagingSupabaseUrl"' "$MANIFEST_FILE" | head -1 | sed -e 's/.*"approvedStagingSupabaseUrl"[[:space:]]*:[[:space:]]*"//' -e 's/".*//')

  # Validate IMAGE_REF
  if [ -z "$IMAGE_REF" ]; then
    fail "TUGPT_WEB_STAGING_IMAGE is missing or empty (approved image digest required)"
  else
    # Must match repository@sha256:<64-hex>
    case "$IMAGE_REF" in
      *@sha256:[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]*)
        # Extract digest part
        img_digest=$(printf '%s' "$IMAGE_REF" | sed -e 's/.*@//')
        if [ "$img_digest" = "$APPROVED_DIGEST" ]; then
          pass "TUGPT_WEB_STAGING_IMAGE matches approved digest ($APPROVED_DIGEST)"
        else
          fail "TUGPT_WEB_STAGING_IMAGE digest '$img_digest' does not match administrator-approved digest '$APPROVED_DIGEST'"
        fi
        ;;
      *:*)
        fail "TUGPT_WEB_STAGING_IMAGE uses a mutable tag instead of @sha256: digest ($IMAGE_REF)"
        ;;
      *)
        fail "TUGPT_WEB_STAGING_IMAGE malformed; must be repository@sha256:<digest> ($IMAGE_REF)"
        ;;
    esac
  fi

  # Validate build-time URL matches runtime URL if specified in manifest
  if [ -n "$APPROVED_URL" ]; then
    if [ "$SUPABASE_URL" = "$APPROVED_URL" ]; then
      pass "Runtime Supabase URL matches build-time release manifest URL"
    else
      fail "Runtime Supabase URL ($SUPABASE_URL) does not match build-time manifest URL ($APPROVED_URL)"
    fi
  fi
else
  if [ -n "$IMAGE_REF" ]; then
    case "$IMAGE_REF" in
      *@sha256:[a-f0-9]*) pass "TUGPT_WEB_STAGING_IMAGE contains sha256 digest" ;;
      *:*) fail "TUGPT_WEB_STAGING_IMAGE uses a mutable tag instead of @sha256: digest ($IMAGE_REF)" ;;
      *) fail "TUGPT_WEB_STAGING_IMAGE malformed ($IMAGE_REF)" ;;
    esac
  else
    fail "TUGPT_WEB_STAGING_IMAGE is missing"
  fi
fi

if [ "$errors" -gt 0 ]; then
  printf '\nStaging preflight failed with %d error(s).\n' "$errors" >&2
  exit 1
fi

printf '\nStaging preflight passed: all isolation checks green.\n'
exit 0