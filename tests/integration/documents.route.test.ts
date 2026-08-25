import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

// Needs a real database + Redis, same as the other integration suites — and
// additionally spins up the REAL ocr/extraction BullMQ workers in-process so
// jobs enqueued by a real HTTP upload actually get processed, rather than
// mocking the pipeline. Only ALLOW_MOCK_PROCESSING (already set by CI/local
// test env) keeps this from needing real AWS/Anthropic credentials — the
// worker code itself, the queue wiring, and the decision engine all run for
// real.
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration('documents route (integration, full pipeline)', () => {
  let app: typeof import('../../src/app.js').app;
  let AuthService: typeof import('../../src/services/auth.service.js');
  let pool: typeof import('../../src/db/index.js').pool;
  let redis: typeof import('../../src/lib/redis.js').redis;
  let ocrWorker: import('bullmq').Worker;
  let extractionWorker: import('bullmq').Worker;

  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `docs-route-test-${suffix}`;
  const adminEmail = `docs-route-admin-${suffix}@example.test`;
  const viewerEmail = `docs-route-viewer-${suffix}@example.test`;
  const password = 'correct-horse-battery-staple';

  let adminToken: string;
  let viewerToken: string;
  let tenantId: string;

  beforeAll(async () => {
    ({ app } = await import('../../src/app.js'));
    AuthService = await import('../../src/services/auth.service.js');
    ({ pool } = await import('../../src/db/index.js'));
    ({ redis } = await import('../../src/lib/redis.js'));
    if (redis.status !== 'ready') await redis.connect();

    const { createOcrWorker } = await import('../../src/workers/ocr.worker.js');
    const { createExtractionWorker } = await import('../../src/workers/extraction.worker.js');
    ocrWorker = createOcrWorker();
    extractionWorker = createExtractionWorker();

    const admin = await AuthService.register({
      tenantName: 'Docs Route Test Co',
      tenantSlug,
      email: adminEmail,
      password,
    });
    tenantId = admin.tenant.id;
    const adminLogin = await AuthService.login({ email: adminEmail, password });
    adminToken = adminLogin.accessToken;

    // A second, lower-privileged user to exercise requireRole over real HTTP.
    // Must go through withTenantContext, not a raw pool query — RLS blocks
    // an insert with no tenant context set, same reason register() does.
    const { withTenantContext } = await import('../../src/db/index.js');
    const { users } = await import('../../src/db/schema.js');
    const { hashPassword } = await import('../../src/lib/password.js');
    await withTenantContext(tenantId, async (tx) => {
      await tx.insert(users).values({
        tenantId,
        email: viewerEmail,
        passwordHash: await hashPassword(password),
        role: 'viewer',
      });
    });
    const viewerLogin = await AuthService.login({ email: viewerEmail, password });
    viewerToken = viewerLogin.accessToken;
  });

  afterAll(async () => {
    await ocrWorker?.close();
    await extractionWorker?.close();
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    const { closeRedis } = await import('../../src/lib/redis.js');
    await closeRedis();
  });

  async function waitForStatus(documentId: string, target: string, timeoutMs = 10_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(app)
        .get(`/api/v1/documents/${documentId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      if (res.body?.document?.status === target) return res.body.document;
      if (res.body?.document?.status === 'failed') {
        throw new Error(`Document moved to 'failed' while waiting for '${target}': ${JSON.stringify(res.body.document)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for document ${documentId} to reach status '${target}'`);
  }

  it('rejects upload with no auth token', async () => {
    const res = await request(app)
      .post('/api/v1/documents')
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(401);
  });

  it('uploads a document, and it runs through the real OCR -> extraction -> decision pipeline to pending_review', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('%PDF-1.4 fake invoice content'), { filename: 'invoice.pdf', contentType: 'application/pdf' });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.document.status).toBe('uploaded');
    const documentId = uploadRes.body.document.id;

    // Mock extraction data is deliberately built with two fields below the
    // default 0.85 threshold (see anthropic.ts's extractMock comment), so
    // this should always land in pending_review, never auto-approved —
    // exercising the review path, not just the happy path.
    const final = await waitForStatus(documentId, 'pending_review');
    expect(final.docType).toBe('invoice');

    const detail = await request(app)
      .get(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.body.document.extraction.vendorName).toBe('Acme Supplies Ltd');
    expect(detail.body.document.extraction.invoiceNumber).toMatch(/^INV-MOCK-/);
    // Math cross-validation: line items (250+250+100=600) match subtotal exactly.
    expect(Number(detail.body.document.extraction.subtotal)).toBeCloseTo(600.0, 2);

    const auditEvents = detail.body.document.auditLog.map((a: { event: string }) => a.event);
    expect(auditEvents).toEqual(
      expect.arrayContaining(['uploaded', 'ocr_complete', 'extracted', 'sent_to_review']),
    );
  }, 15_000);

  it('a viewer cannot approve a document (requireRole enforced over real HTTP)', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('%PDF-1.4 fake invoice content 2'), { filename: 'invoice2.pdf', contentType: 'application/pdf' });
    const documentId = uploadRes.body.document.id;
    await waitForStatus(documentId, 'pending_review');

    const res = await request(app)
      .post(`/api/v1/documents/${documentId}/approve`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  }, 15_000);

  it('an admin approves a pending_review document, and it cannot be approved twice', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('%PDF-1.4 fake invoice content 3'), { filename: 'invoice3.pdf', contentType: 'application/pdf' });
    const documentId = uploadRes.body.document.id;
    await waitForStatus(documentId, 'pending_review');

    const approveRes = await request(app)
      .post(`/api/v1/documents/${documentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.document.status).toBe('approved');

    const secondApprove = await request(app)
      .post(`/api/v1/documents/${documentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(secondApprove.status).toBe(409);
    expect(secondApprove.body.error.code).toBe('INVALID_DOCUMENT_STATUS');
  }, 15_000);

  it('an admin rejects a pending_review document with a reason', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('%PDF-1.4 fake invoice content 4'), { filename: 'invoice4.pdf', contentType: 'application/pdf' });
    const documentId = uploadRes.body.document.id;
    await waitForStatus(documentId, 'pending_review');

    const rejectRes = await request(app)
      .post(`/api/v1/documents/${documentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Vendor tax ID looks fabricated' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.document.status).toBe('rejected');

    const detail = await request(app)
      .get(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const rejectEvent = detail.body.document.auditLog.find((a: { event: string }) => a.event === 'rejected');
    expect(rejectEvent.payload.reason).toBe('Vendor tax ID looks fabricated');
  }, 15_000);

  it('a document belonging to another tenant is invisible (404, not leaked)', async () => {
    const other = await AuthService.register({
      tenantName: 'Other Docs Route Co',
      tenantSlug: `${tenantSlug}-other`,
      email: `other-${suffix}@example.test`,
      password,
    });
    const otherLogin = await AuthService.login({ email: `other-${suffix}@example.test`, password });

    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('%PDF-1.4 tenant isolation check'), { filename: 'iso.pdf', contentType: 'application/pdf' });
    const documentId = uploadRes.body.document.id;

    const crossTenantRes = await request(app)
      .get(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${otherLogin.accessToken}`);
    expect(crossTenantRes.status).toBe(404);

    await pool.query('DELETE FROM users WHERE tenant_id = $1', [other.tenant.id]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [other.tenant.id]);
  }, 15_000);
});
