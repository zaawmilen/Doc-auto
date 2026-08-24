# doc-automation-platform — Week 1–2: Foundation

AI Document Automation Platform. This is the Week 1–2 "Foundation" milestone from the
build plan: multi-tenant schema, JWT auth with refresh rotation, file upload, async OCR
via a BullMQ worker, and health/readiness checks.

**Deliverable achieved and verified locally:** upload a PDF → get `raw_text` in the
`documents` table, processed by a separate worker process, without blocking the upload
request.

## What's reused from AIBid2X

Copied close to verbatim: `lib/logger.ts`, `lib/errors.ts` (AppError), `lib/redis.ts`,
`lib/password.ts`, `lib/jwt.ts`/`lib/tokens.ts` (extended with `tenantId`),
`middleware/correlationId.ts`, `requestLogger.ts`, `errorHandler.ts`, `rateLimiter.ts`,
`validate.ts`, the `db/index.ts` + `db/migrate.ts` + `drizzle.config.ts` pattern,
`queues/index.ts`'s BullMQ connection setup, the worker process shutdown pattern, and
`fly.toml` (same app + worker process-group structure).

`requireRole` was adapted for this app's role enum (`admin` / `reviewer` / `viewer`
instead of `bidder` / `seller` / `admin`).

## What's new for this app

- **Multi-tenant schema** — `tenants`, `users`, `documents`, `extractions`,
  `document_audit_log`, `webhook_deliveries` (see `src/db/schema.ts`, matches the
  build plan's Schema tab exactly).
- **Row-level security** (`src/db/migrations/0001_enable_row_level_security.sql`) —
  policies are live in Postgres. **Important caveat:** the app currently enforces
  tenant isolation via `WHERE tenant_id = $tenantId` in every service-layer query
  (`src/services/document.service.ts`) — that's the working gate today. RLS is enabled
  as defense-in-depth, but the app doesn't yet `SET LOCAL app.tenant_id` per request, so
  RLS isn't actively constraining queries yet. A `withTenantContext()` helper is in
  `src/db/index.ts` ready for that wiring — flagged as a Week 3–4 task rather than
  silently claimed as done.
- **Storage abstraction** (`src/lib/storage.ts`) — three drivers: `s3`, `supabase`,
  and `local` (filesystem, for offline dev/testing — not in the original plan, added
  so you can develop without any cloud credentials at all). Switch via `STORAGE_DRIVER`.
- **OCR wrapper** (`src/lib/textract.ts`) — calls AWS Textract's `DetectDocumentText`
  when AWS credentials are present, otherwise returns deterministic mock OCR text
  (same fallback pattern AIBid2X uses for embeddings/analysis).
- **Append-only audit log** (`src/services/audit.service.ts`) — every status
  transition writes a row; nothing is ever updated or deleted.

## Setup

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL (Supabase), REDIS_URL (Upstash), JWT secrets
# (openssl rand -base64 48 for each JWT secret)
npm run db:migrate
npm run dev      # API on :3000
npm run worker    # separate terminal — OCR worker
```

`STORAGE_DRIVER` in `.env` controls which storage backend is used:
- `local` — writes to `./​.local-storage` on disk, zero cloud setup, good for a first smoke test
- `supabase` — Supabase Storage, use this once AWS isn't set up yet (per the build plan's note)
- `s3` — AWS S3, production

Similarly, OCR automatically falls back to mock text if `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` are unset — no Textract access needed to develop Week 1–2.

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

# 4. Confirm raw_text landed (worker runs async — may need a second)
curl localhost:3000/api/v1/documents/<document.id> -H "Authorization: Bearer <accessToken>"
```

I ran exactly this sequence against a local Postgres/Redis while building this — the
response includes `status: "extracted"`, populated `rawText`, and two audit log
entries (`uploaded`, `ocr_complete`).

## Endpoints implemented this milestone

- `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`, `GET /me`
- `POST /api/v1/documents` (multipart upload)
- `GET /api/v1/documents` (list, filter by status, paginated)
- `GET /api/v1/documents/:id` (document + extraction + full audit trail)
- `GET /api/v1/documents/:id/file` (presigned URL, 60s TTL)
- `GET /healthz`, `GET /readyz`

Not yet implemented (later weeks per the plan): classification/extraction workers,
approval/reject/field-edit endpoints, webhook delivery, tenant config endpoints,
metrics endpoint, CI/CD, Fly.io deploy.

## Next: Week 3–4

Classification + extraction workers (Anthropic tool use), Zod validation of LLM
output, confidence scoring, math cross-validation, auto-approve/route-to-review
decision engine, mock extraction fallback (same pattern as `lib/anthropic.ts` in
AIBid2X). Say the word when you're ready and we'll pick it up.
