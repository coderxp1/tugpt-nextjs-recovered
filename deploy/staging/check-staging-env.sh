#!/usr/bin/env sh
#
# deploy/staging/check-staging-env.sh
#
# Preflight environment and release manifest validator for TuGPT staging.
# Validates that staging runtime configuration satisfies all ADR-018 invariants:
# 1. Mandatory administrator release manifest with valid JSON schema (v1.0.0).
# 2. Approved image reference matching repository and exact 64-hex sha256 digest.
# 3. Web-only environment key allowlist (no unknown, provider, or privileged keys).
# 4. Strict rejection of all TUGPT_SECRET_KEY_* platform master secrets (even empty).
# 5. Positive staging Supabase HTTPS URL validation (no userinfo, port, path, query).
# 6. Strict rejection of production Supabase ref (rbiumegrwtavmljxbknp).
# 7. Runtime URL and Anon Key match build-time manifest settings.
# 8. Rejection of command substitutions, shell interpolation, and duplicate keys.
#
# Usage:
#   sh deploy/staging/check-staging-env.sh <env-file> <release-manifest.json>
#
# Exit codes:
#   0 - all validation checks passed
#   1 - validation or schema failure
#   2 - configuration or manifest file missing/unreadable

set -u

ENV_FILE="${1:-}"
MANIFEST_FILE="${2:-}"

errors=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  errors=$((errors + 1))
}

# ------------------------------------------------------------------------------
# 1. Require Environment File
# ------------------------------------------------------------------------------
if [ -z "$ENV_FILE" ]; then
  printf 'FAIL: Staging environment file path is required as argument 1.\n' >&2
  exit 2
fi

if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
  printf 'FAIL: Configuration file "%s" is not readable or does not exist.\n' "$ENV_FILE" >&2
  exit 2
fi

# ------------------------------------------------------------------------------
# 2. Require Administrator Release Manifest (Fail-Closed)
# ------------------------------------------------------------------------------
if [ -z "$MANIFEST_FILE" ]; then
  printf 'FAIL: Release manifest path is required as argument 2.\n' >&2
  exit 2
fi

if [ ! -f "$MANIFEST_FILE" ] || [ ! -r "$MANIFEST_FILE" ]; then
  printf 'FAIL: Release manifest file "%s" is not readable or does not exist.\n' "$MANIFEST_FILE" >&2
  exit 2
fi

# ------------------------------------------------------------------------------
# 3. Ambient Environment Security Scan
# Always scan ambient process environment for any platform master secrets
# ------------------------------------------------------------------------------
ambient_secrets=$(env 2>/dev/null | grep -E '^TUGPT_SECRET_KEY_' | cut -d= -f1 || true)
for s in $ambient_secrets; do
  fail "Prohibited platform master secret '$s' present in ambient process environment!"
done

# ------------------------------------------------------------------------------
# 4. JSON Schema Validation of Release Manifest
# ------------------------------------------------------------------------------
validate_manifest_json() {
  target="$1"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      let data;
      try {
        const raw = fs.readFileSync(file, "utf8");
        data = JSON.parse(raw);
      } catch (err) {
        console.error("FAIL: Release manifest is not valid JSON: " + err.message);
        process.exit(1);
      }
      const errors = [];
      if (!data || typeof data !== "object") {
        console.error("FAIL: Release manifest must be a JSON object");
        process.exit(1);
      }
      if (data.schemaVersion !== "1.0.0") errors.push("schemaVersion must be 1.0.0");
      if (data.targetEnvironment !== "staging") errors.push("targetEnvironment must be staging");
      if (!data.approvedRepository || typeof data.approvedRepository !== "string" || !/^[a-zA-Z0-9._\-\/]+$/.test(data.approvedRepository)) {
        errors.push("approvedRepository must be a valid repository reference");
      }
      if (!data.approvedDigest || typeof data.approvedDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(data.approvedDigest)) {
        errors.push("approvedDigest must be sha256:<64 lowercase hex characters>");
      }
      if (!data.sourceCommit || typeof data.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(data.sourceCommit)) {
        errors.push("sourceCommit must be a 40-character hex Git commit SHA");
      }
      if (!data.approvedStagingSupabaseUrl || typeof data.approvedStagingSupabaseUrl !== "string" || !/^https:\/\/[a-zA-Z0-9.-]+\.supabase\.(co|in)$/.test(data.approvedStagingSupabaseUrl)) {
        errors.push("approvedStagingSupabaseUrl must be an approved Supabase HTTPS URL");
      }
      if (!data.approvedStagingAnonKey || typeof data.approvedStagingAnonKey !== "string" || data.approvedStagingAnonKey.trim() === "") {
        errors.push("approvedStagingAnonKey must be a non-empty string");
      }
      if (errors.length > 0) {
        console.error("FAIL: Manifest schema validation errors:\n  " + errors.join("\n  "));
        process.exit(1);
      }
      console.log("APPROVED_REPO=" + data.approvedRepository);
      console.log("APPROVED_DIGEST=" + data.approvedDigest);
      console.log("APPROVED_SOURCE_COMMIT=" + data.sourceCommit);
      console.log("APPROVED_URL=" + data.approvedStagingSupabaseUrl);
      console.log("APPROVED_ANON_KEY=" + data.approvedStagingAnonKey);
    ' "$target"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import sys, json, re
file = sys.argv[1]
try:
    with open(file, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as e:
    sys.stderr.write(f"FAIL: Release manifest is not valid JSON: {e}\n")
    sys.exit(1)
errors = []
if not isinstance(data, dict):
    sys.stderr.write("FAIL: Release manifest must be a JSON object\n")
    sys.exit(1)
if data.get("schemaVersion") != "1.0.0": errors.append("schemaVersion must be 1.0.0")
if data.get("targetEnvironment") != "staging": errors.append("targetEnvironment must be staging")
repo = data.get("approvedRepository")
if not repo or not isinstance(repo, str) or not re.match(r"^[a-zA-Z0-9._\-/]+$", repo):
    errors.append("approvedRepository must be a valid repository reference")
digest = data.get("approvedDigest")
if not digest or not isinstance(digest, str) or not re.match(r"^sha256:[a-f0-9]{64}$", digest):
    errors.append("approvedDigest must be sha256:<64 lowercase hex characters>")
commit = data.get("sourceCommit")
if not commit or not isinstance(commit, str) or not re.match(r"^[a-f0-9]{40}$", commit):
    errors.append("sourceCommit must be a 40-character hex Git commit SHA")
url = data.get("approvedStagingSupabaseUrl")
if not url or not isinstance(url, str) or not re.match(r"^https://[a-zA-Z0-9.-]+\.supabase\.(co|in)$", url):
    errors.append("approvedStagingSupabaseUrl must be an approved Supabase HTTPS URL")
anon_key = data.get("approvedStagingAnonKey")
if not anon_key or not isinstance(anon_key, str) or not anon_key.strip():
    errors.append("approvedStagingAnonKey must be a non-empty string")
if errors:
    sys.stderr.write("FAIL: Manifest schema validation errors:\n  " + "\n  ".join(errors) + "\n")
    sys.exit(1)
print("APPROVED_REPO=" + repo)
print("APPROVED_DIGEST=" + digest)
print("APPROVED_SOURCE_COMMIT=" + commit)
print("APPROVED_URL=" + url)
print("APPROVED_ANON_KEY=" + anon_key)
' "$target"
  else
    printf 'FAIL: Neither node nor python3 found for JSON schema validation.\n' >&2
    exit 1
  fi
}

manifest_output=$(validate_manifest_json "$MANIFEST_FILE" 2>&1)
manifest_rc=$?

if [ "$manifest_rc" -ne 0 ]; then
  fail "Release manifest validation failed: $manifest_output"
  exit 1
fi

APPROVED_REPO=$(printf '%s\n' "$manifest_output" | grep '^APPROVED_REPO=' | cut -d= -f2-)
APPROVED_DIGEST=$(printf '%s\n' "$manifest_output" | grep '^APPROVED_DIGEST=' | cut -d= -f2-)
APPROVED_SOURCE_COMMIT=$(printf '%s\n' "$manifest_output" | grep '^APPROVED_SOURCE_COMMIT=' | cut -d= -f2-)
APPROVED_URL=$(printf '%s\n' "$manifest_output" | grep '^APPROVED_URL=' | cut -d= -f2-)
APPROVED_ANON_KEY=$(printf '%s\n' "$manifest_output" | grep '^APPROVED_ANON_KEY=' | cut -d= -f2-)

pass "Release manifest is structurally valid (schema 1.0.0, commit $APPROVED_SOURCE_COMMIT)"

# ------------------------------------------------------------------------------
# 5. Environment File Data-Only Parsing & Allowlist Enforcement
# ------------------------------------------------------------------------------
TUGPT_ENV=""
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
IMAGE_REF=""

SEEN_KEYS=" "

line_num=0
while IFS= read -r raw_line || [ -n "$raw_line" ]; do
  line_num=$((line_num + 1))
  line=$(printf '%s' "$raw_line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

  # Skip blank lines and full-line comments
  case "$line" in
    ""|\#*) continue ;;
  esac

  # Validate KEY=VALUE syntax: key must be alphanumeric + underscore
  case "$line" in
    [A-Za-z_][A-Za-z0-9_]*=*)
      key=$(printf '%s' "$line" | cut -d= -f1)
      val=$(printf '%s' "$line" | cut -d= -f2-)
      ;;
    *)
      fail "Invalid configuration line $line_num: '$line' (must be KEY=VALUE)"
      continue
      ;;
  esac

  # Reject duplicate keys
  case "$SEEN_KEYS" in
    *" $key "*)
      fail "Duplicate key '$key' detected at line $line_num"
      ;;
    *)
      SEEN_KEYS="$SEEN_KEYS$key "
      ;;
  esac

  # Reject shell command substitutions: $(...), `...`, semicolons, and/or
  case "$val" in
    *\$\(*|*\`*|*\;*|*\&\&*|*\|\|*)
      fail "Forbidden shell command substitution syntax detected in key '$key'"
      ;;
  esac

  # Reject simple variable interpolation: $VAR or ${VAR}
  case "$val" in
    *\$[A-Za-z_]*|*\$\{[A-Za-z_]*)
      fail "Forbidden shell variable interpolation syntax detected in key '$key'"
      ;;
  esac

  # Strip surrounding single or double quotes from value
  case "$val" in
    \'*\'|\"*\")
      val=$(printf '%s' "$val" | sed -e "s/^['\"]//" -e "s/['\"]$//")
      ;;
  esac

  # Web-only key allowlist: strictly permit only documented runtime keys
  case "$key" in
    TUGPT_ENVIRONMENT)
      TUGPT_ENV="$val"
      ;;
    TUGPT_WEB_STAGING_IMAGE)
      IMAGE_REF="$val"
      ;;
    NEXT_PUBLIC_SUPABASE_URL)
      SUPABASE_URL="$val"
      ;;
    NEXT_PUBLIC_SUPABASE_ANON_KEY)
      SUPABASE_ANON_KEY="$val"
      ;;
    NODE_ENV|PORT)
      # Allowed optional web runtime variables
      ;;
    TUGPT_SECRET_KEY_*)
      fail "Prohibited platform master secret key '$key' present in staging configuration!"
      ;;
    *)
      fail "Unknown or unauthorized key '$key' present in staging configuration"
      ;;
  esac
done < "$ENV_FILE"

# ------------------------------------------------------------------------------
# 6. Validate TUGPT_ENVIRONMENT
# ------------------------------------------------------------------------------
if [ "$TUGPT_ENV" = "staging" ]; then
  pass "TUGPT_ENVIRONMENT is 'staging'"
else
  fail "TUGPT_ENVIRONMENT must be 'staging' (current: '$TUGPT_ENV')"
fi

# ------------------------------------------------------------------------------
# 7. Validate NEXT_PUBLIC_SUPABASE_URL
# ------------------------------------------------------------------------------
if [ -z "$SUPABASE_URL" ]; then
  fail "NEXT_PUBLIC_SUPABASE_URL is missing or empty"
else
  case "$SUPABASE_URL" in
    https://[a-zA-Z0-9.-]*.supabase.co|https://[a-zA-Z0-9.-]*.supabase.in)
      host_part=$(printf '%s' "$SUPABASE_URL" | sed 's|^https://||')
      case "$host_part" in
        *@*|*:*|*/*|*\?*|*\#*)
          fail "NEXT_PUBLIC_SUPABASE_URL contains invalid userinfo, port, path, or query ($SUPABASE_URL)"
          ;;
        *rbiumegrwtavmljxbknp*)
          fail "NEXT_PUBLIC_SUPABASE_URL targets production project ref (rbiumegrwtavmljxbknp)!"
          ;;
        *)
          if [ "$SUPABASE_URL" = "$APPROVED_URL" ]; then
            pass "NEXT_PUBLIC_SUPABASE_URL is valid and matches release manifest URL"
          else
            fail "Runtime NEXT_PUBLIC_SUPABASE_URL ($SUPABASE_URL) does not match build-time manifest URL ($APPROVED_URL)"
          fi
          ;;
      esac
      ;;
    *)
      fail "NEXT_PUBLIC_SUPABASE_URL is not an approved Supabase HTTPS URL: '$SUPABASE_URL'"
      ;;
  esac
fi

# ------------------------------------------------------------------------------
# 8. Validate NEXT_PUBLIC_SUPABASE_ANON_KEY
# ------------------------------------------------------------------------------
if [ -z "$SUPABASE_ANON_KEY" ]; then
  fail "NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty"
elif [ "$SUPABASE_ANON_KEY" != "$APPROVED_ANON_KEY" ]; then
  fail "Runtime NEXT_PUBLIC_SUPABASE_ANON_KEY does not match build-time manifest anonymous key"
else
  pass "NEXT_PUBLIC_SUPABASE_ANON_KEY is defined and matches release manifest"
fi

# ------------------------------------------------------------------------------
# 9. Validate TUGPT_WEB_STAGING_IMAGE Reference and Digest
# ------------------------------------------------------------------------------
EXPECTED_IMAGE="${APPROVED_REPO}@${APPROVED_DIGEST}"
if [ -z "$IMAGE_REF" ]; then
  fail "TUGPT_WEB_STAGING_IMAGE is missing or empty (approved image reference required)"
elif [ "$IMAGE_REF" != "$EXPECTED_IMAGE" ]; then
  case "$IMAGE_REF" in
    *@sha256:*)
      fail "TUGPT_WEB_STAGING_IMAGE ($IMAGE_REF) does not match approved release manifest ($EXPECTED_IMAGE)"
      ;;
    *:*)
      fail "TUGPT_WEB_STAGING_IMAGE uses a mutable tag instead of @sha256: digest ($IMAGE_REF)"
      ;;
    *)
      fail "TUGPT_WEB_STAGING_IMAGE is malformed; must be repository@sha256:<64-hex> ($IMAGE_REF)"
      ;;
  esac
else
  pass "TUGPT_WEB_STAGING_IMAGE matches approved repository and 64-hex digest ($EXPECTED_IMAGE)"
fi

# ------------------------------------------------------------------------------
# 10. Summary and Exit
# ------------------------------------------------------------------------------
if [ "$errors" -gt 0 ]; then
  printf '\nPreflight validation FAILED with %d error(s).\n' "$errors" >&2
  exit 1
fi

printf '\nPreflight validation PASSED.\n'
exit 0