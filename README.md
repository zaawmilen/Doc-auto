# doc-automation-platform

![CI](https://github.com/zaawmilen/Doc-auto/actions/workflows/ci.yml/badge.svg)

AI Document Automation Platform: multi-tenant schema with enforced row-level security,
JWT auth with refresh rotation, async document processing (OCR → LLM classification →
structured extraction → confidence-based auto-approve/route-to-review), and a full
review/approve/reject/reprocess workflow with an append-only audit trail.

**Deliverable, verified end-to-end (both manually and under a real, automated test
suite — see `tests/integration/documents.route.test.ts`):** upload a PDF → OCR runs on
a separate worker process → an LLM classifies and extracts structured invoice data →
a decision engine either auto-approves it or routes it to human review → a reviewer
can approve, reject with a reason, edit an extracted field, or trigger a full
reprocess — all without blocking the original upload request, and none of it visible
across tenants.

## What's reused from AIBid2X

Copied close to verbatim: `lib/logger.ts`, `lib/errors.ts` (AppError), `lib/redis.ts`,
`lib/password.ts`, `lib/jwt.ts`/`lib/tokens.ts` (extended with `tenantId`),
`middleware/correlationId.ts`, `requestLogger.ts`, `errorHandler.ts`, `rateLimiter.ts`,
`validate.ts`, the `db/index.ts` + `db/migrate.ts` + `drizzle.config.ts` pattern,
`queues/index.ts`'s BullMQ connection setup, the worker process shutdown pattern, and
`fly.toml` (same app + worker process-group structure).

`requireRole` was adapted for this app's role enum (`admin` / `reviewer` / `viewer`
instead of `bidder` / `seller` / `admin`).

## What's built

- **Multi-tenant schema** — `tenants`, `users`, `documents`, `documents_extraction`,
  `document_audit_log`, `webhook_deliveries` (see `src/db/schema.ts`).
- **Row-level security, actually enforced** (`src/db/migrations/0001`, `0007`, `0008`)
  — every tenant-scoped query runs inside `withTenantContext()` (`src/db/index.ts`),
  which sets `app.tenant_id` for the transaction; RLS policies scope both visibility
  and inserts to that context. Two things worth knowing about this design:
  - Registration and login necessarily happen *before* a tenant context can exist.
    Registration solves this by generating the new tenant's id up front and using it
    as the transaction's own context (migration 0008's commit message has the detail).
    Login can't do that — it doesn't know the tenant yet — so it uses a single,
    narrowly-scoped `SECURITY DEFINER` Postgres function (`find_user_for_login`,
    migration 0008) that returns only the five columns needed, for at most one row,
    owned by a dedicated role that exists solely to own that function. The app's own
    connection role never gains RLS bypass.
  - Deploying against Supabase requires a one-time privileged setup step (creating
    that dedicated role) — documented in migration 0008's header comment. It's
    designed to fail loudly if skipped, not silently leave the function unable to
    do its job.
- **Storage abstraction** (`src/lib/storage.ts`) — three drivers: `s3`, `supabase`,
  and `local` (filesystem, for offline dev/testing). Switch via `STORAGE_DRIVER`.
- **OCR wrapper** (`src/lib/textract.ts`) — calls AWS Textract's `DetectDocumentText`
  when AWS credentials are present, otherwise returns deterministic mock OCR text.
- **LLM classification + extraction** (`src/lib/anthropic.ts`) — Claude tool-use calls
  with a strict Zod schema on the output, per-field confidence scores kept separate
  from the values, retry logic, per-call cost logging, and a deterministic mock
  fallback (including two fields deliberately below the default confidence threshold,
  so the review path is exercised even without a real API key).
- **Decision engine** (`src/lib/decision-engine.ts`) — auto-approve requires every
  field's confidence at or above the tenant's threshold *and* line items summing to
  the stated subtotal within a cent; anything else routes to human review.
- **Review workflow** — approve, reject (with a required reason), edit an individual
  extracted field, and reprocess (resets a failed/rejected document and re-runs the
  full pipeline under a new run id) — see `src/routes/documents.ts`.
- **Append-only audit log** (`src/services/audit.service.ts`) — every status
  transition writes a row; nothing is ever updated or deleted.
- **Webhook delivery** (`src/lib/webhooks.ts`, `src/workers/webhook.worker.ts`) — fires
  when a document reaches `approved` or `rejected` (auto-approve or manual). HMAC-SHA256
  signed (`X-Webhook-Signature`), 10s timeout, and a self-contained retry/dead-letter
  scheme: attempt numbering comes from how many `webhook_deliveries` rows already exist
  for that document, not from BullMQ's own retry counter — keeps the escalation logic
  fully in application state and easy to test without waiting through real backoff delays.
  Skipped entirely (no job enqueued) if a tenant has no `webhookUrl` configured.
- **CI** (`.github/workflows/ci.yml`) — typecheck, migrate, and the full test suite
  against real Postgres + Redis service containers on every push/PR, connecting as a
  dedicated non-superuser role so RLS is actually exercised the same way it would be
  in production, not silently bypassed the way a superuser or BYPASSRLS role would.

## Setup

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL (Supabase), REDIS_URL (Upstash), JWT secrets
# (openssl rand -base64 48 for each JWT secret)
npm run db:migrate
npm run dev      # API on :3000
npm run worker    # separate terminal — runs both the OCR and extraction workers
```

`STORAGE_DRIVER` in `.env` controls which storage backend is used:
- `local` — writes to `./.local-storage` on disk, zero cloud setup, good for a first smoke test
- `supabase` — Supabase Storage, use this once AWS isn't set up yet
- `s3` — AWS S3, production

Similarly, OCR and LLM classification/extraction automatically fall back to
deterministic mock output if `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and
`ANTHROPIC_API_KEY` are unset, respectively — no cloud credentials needed to develop
or run the test suite locally.

**Deploying against Supabase:** run the one-time privileged setup in migration
0008's header comment via the Supabase SQL editor before running migrations —
without it, the migration will fail loudly at the `ALTER FUNCTION ... OWNER TO` step
rather than silently leave login unable to work.

## Verifying the deliverable yourself

```bash
# 1. Register a tenant + admin user
curl -X POST localhost:3000/api/v1/auth/register -H "Content-Type: application/json" \
  -d '{"tenantName":"Acme Corp","tenantSlug":"acme-corp","email":"admin@acme.test","password":"testpassword123"}'

# 2. Log in
curl -X POST localhost:3000/api/v1/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@acme.test","password":"testpassword123"}'
# copy accessToken from the response

# 3. Upload a PDF
curl -X POST localhost:3000/api/v1/documents \
  -H "Authorization: Bearer <accessToken>" \
  -F "file=@/path/to/invoice.pdf;type=application/pdf"
# copy the returned document.id

# 4. Poll until it reaches pending_review (worker runs async — usually well under a second)
curl localhost:3000/api/v1/documents/<document.id> -H "Authorization: Bearer <accessToken>"

# 5. Approve it (or reject with a reason, or edit a field first)
curl -X POST localhost:3000/api/v1/documents/<document.id>/approve \
  -H "Authorization: Bearer <accessToken>"
```

This exact sequence (register → login → upload → poll → approve, plus reject and
reprocess variants, plus a cross-tenant-isolation check) runs against real Postgres
and Redis in `tests/integration/documents.route.test.ts`, with the real OCR and
extraction workers processing real BullMQ jobs — not mocked at the pipeline level,
only the external OCR/LLM API calls are.

## Endpoints implemented

- `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`, `GET /me`
- `POST /api/v1/documents` (multipart upload)
- `GET /api/v1/documents` (list, filter by status, paginated)
- `GET /api/v1/documents/:id` (document + extraction + full audit trail)
- `GET /api/v1/documents/:id/file` (presigned URL, 60s TTL)
- `POST /api/v1/documents/:id/approve`, `/reject` (admin/reviewer only)
- `PATCH /api/v1/documents/:id/extraction` (edit an extracted field, admin/reviewer only)
- `POST /api/v1/documents/:id/reprocess` (admin/reviewer only)
- `GET`/`PATCH /api/v1/tenant` (extraction threshold, webhook URL — admin-only for PATCH)
- `POST /api/v1/tenant/webhook-secret/rotate` (admin-only; returns the new secret once)
- `GET /healthz`, `GET /readyz`, `GET /metrics`

Not yet implemented: a live deployment (Fly.io config exists but hasn't been deployed
from this environment).

## Test coverage

`npm test` runs the full suite against real Postgres + Redis — see `tests/`. Highlights:
unit tests for access-control middleware (including a deliberately-broken-then-restored
check to confirm they catch real regressions, not just decorate); integration tests for
auth (register/login/refresh/logout, all against real infra); a full route-level test
that spins up the actual BullMQ workers and drives a document through the entire
pipeline over real HTTP; and filesystem-backed tests for the local storage driver.

