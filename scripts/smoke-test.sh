#!/usr/bin/env bash
#
# scripts/smoke-test.sh
#
# End-to-end smoke test against a running instance of the API + worker.
# Exercises: health checks, register/login/me, upload -> OCR -> classify ->
# extract -> decision engine, refresh token rotation, logout, and a few
# negative paths (bad mime type, oversized file, reused refresh token).
#
# Usage:
#   BASE_URL=http://localhost:3000 ./scripts/smoke-test.sh
#   BASE_URL=https://your-app.fly.dev ./scripts/smoke-test.sh
#
# Requires: curl, node (already a project dependency, used here only for
# JSON parsing so this script has no extra dependencies to install).
#
# Exit code: 0 if every check passed, 1 if any check failed.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-15}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-1}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

# ── Output helpers ─────────────────────────────────────────────────────────────

log_info()  { printf '  %s\n' "$1"; }
log_pass()  { printf '  \033[32m✓ PASS\033[0m  %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
log_fail()  { printf '  \033[31m✗ FAIL\033[0m  %s\n' "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
log_section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Extract a value from JSON on stdin via a JS expression evaluated with `d`
# bound to the parsed JSON, e.g.:
#   echo "$RESPONSE" | json 'd.document.id'
#   echo "$RESPONSE" | json 'd.document.rawText ? d.document.rawText.length : 0'
json() {
  node -e "
    let raw = require('fs').readFileSync(0, 'utf8');
    try {
      let d = JSON.parse(raw);
      let v = (function(d) { try { return ($1); } catch { return undefined; } })(d);
      console.log(v === undefined ? '' : v);
    } catch (e) {
      process.exit(1);
    }
  "
}

# curl wrapper that captures both body and status code.
# Sets globals: HTTP_BODY, HTTP_STATUS
http() {
  local method="$1"; shift
  local path="$1"; shift
  local response
  response="$(curl -s -w '\n%{http_code}' -X "$method" "$BASE_URL$path" "$@")"
  HTTP_STATUS="$(printf '%s' "$response" | tail -n1)"
  HTTP_BODY="$(printf '%s' "$response" | sed '$d')"
}

require_status() {
  local expected="$1" description="$2"
  if [ "$HTTP_STATUS" = "$expected" ]; then
    log_pass "$description (HTTP $HTTP_STATUS)"
    return 0
  else
    log_fail "$description — expected HTTP $expected, got HTTP $HTTP_STATUS: $HTTP_BODY"
    return 1
  fi
}

# ── Test fixtures ────────────────────────────────────────────────────────────

RUN_ID="$(date +%s)$$"
TENANT_SLUG="smoke-test-${RUN_ID}"
EMAIL="smoke-${RUN_ID}@test.local"
PASSWORD="smoke-test-password-123"

# Minimal valid single-page PDF — no external tools needed to generate it.
PDF_PATH="$WORKDIR/test-invoice.pdf"
cat > "$PDF_PATH" << 'PDFEOF'
%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
xref
0 4
0000000000 65535 f 
trailer<</Size 4/Root 1 0 R>>
startxref
0
%%EOF
PDFEOF

BAD_MIME_PATH="$WORKDIR/not-a-document.txt"
echo "this is not a pdf" > "$BAD_MIME_PATH"

log_section "Smoke test against $BASE_URL"
log_info "run id: $RUN_ID"

# ── 1. Health checks ─────────────────────────────────────────────────────────

log_section "1. Health checks"

http GET /healthz
require_status 200 "GET /healthz"

http GET /readyz
if [ "$HTTP_STATUS" = "200" ]; then
  DB_CHECK="$(printf '%s' "$HTTP_BODY" | json 'd.checks.database')"
  REDIS_CHECK="$(printf '%s' "$HTTP_BODY" | json 'd.checks.redis')"
  log_pass "GET /readyz (HTTP 200, database=$DB_CHECK, redis=$REDIS_CHECK)"
else
  log_fail "GET /readyz — expected HTTP 200, got HTTP $HTTP_STATUS: $HTTP_BODY"
  log_info "Stopping here — nothing downstream will work if readiness fails."
  printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$PASS_COUNT" "$FAIL_COUNT"
  exit 1
fi

# ── 2. Register + login ──────────────────────────────────────────────────────

log_section "2. Auth: register, login, me"

http POST /api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"tenantName\":\"Smoke Test\",\"tenantSlug\":\"$TENANT_SLUG\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
require_status 201 "POST /auth/register"
TENANT_ID="$(printf '%s' "$HTTP_BODY" | json 'd.tenant.id')"

http POST /api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
if require_status 200 "POST /auth/login"; then
  ACCESS_TOKEN="$(printf '%s' "$HTTP_BODY" | json 'd.accessToken')"
  REFRESH_TOKEN="$(printf '%s' "$HTTP_BODY" | json 'd.refreshToken')"
else
  log_info "Cannot continue without a valid session — stopping here."
  printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$PASS_COUNT" "$FAIL_COUNT"
  exit 1
fi

http GET /api/v1/auth/me -H "Authorization: Bearer $ACCESS_TOKEN"
if require_status 200 "GET /auth/me"; then
  ME_TENANT_ID="$(printf '%s' "$HTTP_BODY" | json 'd.user.tenantId')"
  if [ "$ME_TENANT_ID" = "$TENANT_ID" ]; then
    log_pass "/me returns matching tenantId"
  else
    log_fail "/me tenantId mismatch: expected $TENANT_ID, got $ME_TENANT_ID"
  fi
fi

# Wrong password should be rejected
http POST /api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}"
require_status 401 "POST /auth/login with wrong password is rejected"

# ── 3. Upload rejection paths ────────────────────────────────────────────────

log_section "3. Upload validation"

http POST /api/v1/documents \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "file=@$BAD_MIME_PATH;type=text/plain"
require_status 400 "POST /documents rejects unsupported mime type"

http POST /api/v1/documents
require_status 401 "POST /documents without auth token is rejected"

# Oversized file — only meaningful if MAX_UPLOAD_BYTES is small enough to
# exceed without writing a huge temp file. Skips gracefully otherwise.
MAX_UPLOAD_BYTES_ENV="${MAX_UPLOAD_BYTES:-15728640}"
if [ "$MAX_UPLOAD_BYTES_ENV" -le 52428800 ] 2>/dev/null; then
  OVERSIZED_PATH="$WORKDIR/oversized.pdf"
  OVERSIZED_BYTES=$((MAX_UPLOAD_BYTES_ENV + 1024))
  head -c "$OVERSIZED_BYTES" /dev/urandom > "$OVERSIZED_PATH" 2>/dev/null
  http POST /api/v1/documents \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -F "file=@$OVERSIZED_PATH;type=application/pdf"
  require_status 400 "POST /documents rejects file over MAX_UPLOAD_BYTES ($MAX_UPLOAD_BYTES_ENV)"
else
  log_info "Skipping oversized-file test — MAX_UPLOAD_BYTES ($MAX_UPLOAD_BYTES_ENV) too large to test cheaply. Set MAX_UPLOAD_BYTES env var to override."
fi

# ── 4. Full pipeline: upload -> OCR -> classify -> extract -> decision ──────

log_section "4. Document pipeline"

http POST /api/v1/documents \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "file=@$PDF_PATH;type=application/pdf"
if require_status 201 "POST /documents (valid PDF)"; then
  DOC_ID="$(printf '%s' "$HTTP_BODY" | json 'd.document.id')"
  INITIAL_STATUS="$(printf '%s' "$HTTP_BODY" | json 'd.document.status')"
  if [ "$INITIAL_STATUS" = "uploaded" ]; then
    log_pass "Upload response is instant (status=uploaded, not blocked on OCR)"
  else
    log_fail "Expected initial status 'uploaded', got '$INITIAL_STATUS'"
  fi
else
  log_info "Cannot continue pipeline checks without an uploaded document."
  DOC_ID=""
fi

if [ -n "$DOC_ID" ]; then
  log_info "Polling document $DOC_ID (up to ${POLL_ATTEMPTS}x, ${POLL_INTERVAL_SECONDS}s apart)..."
  FINAL_STATUS=""
  for i in $(seq 1 "$POLL_ATTEMPTS"); do
    sleep "$POLL_INTERVAL_SECONDS"
    http GET "/api/v1/documents/$DOC_ID" -H "Authorization: Bearer $ACCESS_TOKEN"
    STATUS="$(printf '%s' "$HTTP_BODY" | json 'd.document.status')"
    case "$STATUS" in
      approved|pending_review|rejected|failed)
        FINAL_STATUS="$STATUS"
        break
        ;;
    esac
  done

  if [ -z "$FINAL_STATUS" ]; then
    log_fail "Document did not reach a terminal state within $((POLL_ATTEMPTS * POLL_INTERVAL_SECONDS))s (stuck at '$STATUS') — is the worker process running?"
  elif [ "$FINAL_STATUS" = "failed" ]; then
    log_fail "Document pipeline ended in 'failed' — check worker logs"
  else
    log_pass "Pipeline reached terminal state: $FINAL_STATUS"

    RAW_TEXT_LEN="$(printf '%s' "$HTTP_BODY" | json 'd.document.rawText ? d.document.rawText.length : 0')"
    if [ "$RAW_TEXT_LEN" != "0" ] && [ -n "$RAW_TEXT_LEN" ]; then
      log_pass "OCR populated raw_text ($RAW_TEXT_LEN chars)"
    else
      log_fail "raw_text is empty — OCR did not run or failed silently"
    fi

    DOC_TYPE="$(printf '%s' "$HTTP_BODY" | json 'd.document.docType')"
    log_info "doc_type: $DOC_TYPE"

    HAS_EXTRACTION="$(printf '%s' "$HTTP_BODY" | json 'd.document.extraction ? "yes" : "no"')"
    if [ "$HAS_EXTRACTION" = "yes" ]; then
      log_pass "Extraction record present"
      MIN_CONF_FIELDS="$(printf '%s' "$HTTP_BODY" | json 'JSON.stringify(d.document.extraction.confidenceScores)')"
      log_info "confidence scores: $MIN_CONF_FIELDS"
    elif [ "$DOC_TYPE" = "unknown" ]; then
      log_pass "No extraction record — expected, doc_type was classified unknown"
    else
      log_fail "Expected an extraction record for doc_type=$DOC_TYPE, found none"
    fi

    AUDIT_EVENTS="$(printf '%s' "$HTTP_BODY" | json "d.document.auditLog.map(a => a.event).reverse().join(',')")"
    log_info "audit trail: $AUDIT_EVENTS"
    case "$AUDIT_EVENTS" in
      uploaded,*)
        log_pass "Audit trail starts with 'uploaded'"
        ;;
      *)
        log_fail "Audit trail does not start with 'uploaded': $AUDIT_EVENTS"
        ;;
    esac
  fi

  http GET "/api/v1/documents/$DOC_ID/file" -H "Authorization: Bearer $ACCESS_TOKEN"
  if require_status 200 "GET /documents/:id/file"; then
    FILE_URL="$(printf '%s' "$HTTP_BODY" | json 'd.url')"
    if [ -n "$FILE_URL" ]; then
      log_pass "Presigned URL returned"
    else
      log_fail "Presigned URL response missing 'url' field"
    fi
  fi
fi

# ── 5. List + filter ──────────────────────────────────────────────────────────

log_section "5. List documents"

http GET "/api/v1/documents?page=1&pageSize=10" -H "Authorization: Bearer $ACCESS_TOKEN"
if require_status 200 "GET /documents (list)"; then
  TOTAL="$(printf '%s' "$HTTP_BODY" | json 'd.total')"
  log_info "total documents for this tenant: $TOTAL"
fi

# ── 6. Refresh token rotation (single-use) ───────────────────────────────────

log_section "6. Refresh token rotation"

http POST /api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
if require_status 200 "POST /auth/refresh with valid token"; then
  NEW_REFRESH_TOKEN="$(printf '%s' "$HTTP_BODY" | json 'd.refreshToken')"
else
  NEW_REFRESH_TOKEN=""
fi

# Reusing the OLD refresh token should now fail — proves rotation is single-use.
http POST /api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
require_status 401 "Reusing an already-rotated refresh token is rejected"

# ── 7. Logout ─────────────────────────────────────────────────────────────────

log_section "7. Logout"

if [ -n "$NEW_REFRESH_TOKEN" ]; then
  http POST /api/v1/auth/logout \
    -H "Content-Type: application/json" \
    -d "{\"refreshToken\":\"$NEW_REFRESH_TOKEN\"}"
  require_status 204 "POST /auth/logout"

  http POST /api/v1/auth/refresh \
    -H "Content-Type: application/json" \
    -d "{\"refreshToken\":\"$NEW_REFRESH_TOKEN\"}"
  require_status 401 "Refreshing with a logged-out token is rejected"
else
  log_fail "Skipped logout test — no refresh token available from step 6"
fi

# ── Summary ────────────────────────────────────────────────────────────────────

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$PASS_COUNT" "$FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
