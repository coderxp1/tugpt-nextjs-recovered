#!/usr/bin/env sh
#
# deploy/staging/check-staging-env.sh
#
# Preflight validation for staging environment before container startup.
# Verifies environment variables / env file against isolation invariants:
#
# 1. TUGPT_ENVIRONMENT must be 'staging'.
# 2. NEXT_PUBLIC_SUPABASE_URL must be set and non-empty.
# 3. NEXT_PUBLIC_SUPABASE_URL must NOT target production project ref (rbiumegrwtavmljxbknp).
# 4. NEXT_PUBLIC_SUPABASE_ANON_KEY must be set and non-empty.
# 5. TUGPT_SECRET_KEY_PLATFORM_V1 must be completely ABSENT (preventing production secret contamination).
#
# Usage:
#   sh deploy/staging/check-staging-env.sh [/path/to/staging.env]
#
# Exit codes:
#   0 - all checks passed
#   1 - one or more validation errors
#   2 - configuration file could not be read

set -u

ENV_FILE="${1:-}"
if [ -n "$ENV_FILE" ]; then
  if [ ! -r "$ENV_FILE" ]; then
    printf 'FAIL: Env file "%s" is not readable or does not exist.\n' "$ENV_FILE" >&2
    exit 2
  fi
  # Source the environment file
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
fi

errors=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  errors=$((errors + 1))
}

# 1. Check TUGPT_ENVIRONMENT
ENV_VAL="${TUGPT_ENVIRONMENT:-}"
if [ "$ENV_VAL" = "staging" ]; then
  pass "TUGPT_ENVIRONMENT is 'staging'"
else
  fail "TUGPT_ENVIRONMENT must be 'staging' (current: '$ENV_VAL')"
fi

# 2. Check NEXT_PUBLIC_SUPABASE_URL presence
URL_VAL="${NEXT_PUBLIC_SUPABASE_URL:-}"
if [ -z "$URL_VAL" ]; then
  fail "NEXT_PUBLIC_SUPABASE_URL is missing or empty"
else
  pass "NEXT_PUBLIC_SUPABASE_URL is defined"
fi

# 3. Check for production Supabase project ref
PROD_REF="rbiumegrwtavmljxbknp"
case "$URL_VAL" in
  *"$PROD_REF"*)
    fail "NEXT_PUBLIC_SUPABASE_URL targets production project ref ($PROD_REF)! Staging must use a distinct project."
    ;;
  *)
    if [ -n "$URL_VAL" ]; then
      pass "NEXT_PUBLIC_SUPABASE_URL does not target production project ref"
    fi
    ;;
esac

# 4. Check NEXT_PUBLIC_SUPABASE_ANON_KEY presence
ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"
if [ -z "$ANON_KEY" ]; then
  fail "NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty"
else
  pass "NEXT_PUBLIC_SUPABASE_ANON_KEY is defined"
fi

# 5. Check TUGPT_SECRET_KEY_PLATFORM_V1 absence
if [ -n "${TUGPT_SECRET_KEY_PLATFORM_V1:-}" ]; then
  fail "TUGPT_SECRET_KEY_PLATFORM_V1 is present! Production master platform keys are forbidden in staging."
else
  pass "TUGPT_SECRET_KEY_PLATFORM_V1 is absent (correct for staging)"
fi

if [ "$errors" -gt 0 ]; then
  printf '\nStaging preflight failed with %d error(s).\n' "$errors" >&2
  exit 1
fi

printf '\nStaging preflight passed: all isolation checks green.\n'
exit 0