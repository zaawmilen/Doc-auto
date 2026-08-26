import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signWebhookBody } from '../../src/lib/webhooks.js';

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration('webhook worker', () => {
  let AuthService: typeof import('../../src/services/auth.service.js');
  let DocumentService: typeof import('../../src/services/document.service.js');
  let pool: typeof import('../../src/db/index.js').pool;
  let db: typeof import('../../src/db/index.js').db;
  let withTenantContext: typeof import('../../src/db/index.js').withTenantContext;
  let webhookDeliveries: typeof import('../../src/db/schema.js').webhookDeliveries;
  let documentAuditLog: typeof import('../../src/db/schema.js').documentAuditLog;
  let documents: typeof import('../../src/db/schema.js').documents;
  let tenants: typeof import('../../src/db/schema.js').tenants;
  let processWebhookJob: typeof import('../../src/workers/webhook.worker.js').processWebhookJob;
  let redis: typeof import('../../src/lib/redis.js').redis;
  let eq: typeof import('drizzle-orm').eq;

  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `webhook-test-${suffix}`;
  const adminEmail = `webhook-admin-${suffix}@example.test`;
  const password = 'correct-horse-battery-staple';
  const webhookSecret = 'a-test-secret-not-used-anywhere-real';

  let tenantId: string;
  let adminUserId: string;
  let adminToken: string;
  let receiverUrl: string;
  let receiverServer: Server;
  let webhookWorker: import('bullmq').Worker;
  let receivedRequests: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
  let receiverBehavior: 'success' | 'fail' = 'success';

  beforeAll(async () => {
    AuthService = await import('../../src/services/auth.service.js');
    DocumentService = await import('../../src/services/document.service.js');
    ({ pool, db, withTenantContext } = await import('../../src/db/index.js'));
    ({ webhookDeliveries, documentAuditLog, documents, tenants } = await import('../../src/db/schema.js'));
    ({ processWebhookJob } = await import('../../src/workers/webhook.worker.js'));
    ({ redis } = await import('../../src/lib/redis.js'));
    ({ eq } = await import('drizzle-orm'));
    if (redis.status !== 'ready') await redis.connect();

    receivedRequests = [];
    receiverServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (receiverBehavior === 'success') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('simulated receiver failure');
        }
      });
    });
    await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
    const addr = receiverServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test webhook receiver');
    receiverUrl = `http://127.0.0.1:${addr.port}/webhook`;

    const admin = await AuthService.register({
      tenantName: 'Webhook Test Co',
      tenantSlug,
      email: adminEmail,
      password,
    });
    tenantId = admin.tenant.id;
    adminUserId = admin.user.id;
    const adminLogin = await AuthService.login({ email: adminEmail, password });
    adminToken = adminLogin.accessToken;

    await withTenantContext(tenantId, async (tx) => {
      await tx.update(tenants).set({ webhookUrl: receiverUrl, webhookSecret }).where(eq(tenants.id, tenantId));
    });

    // Run for the whole suite, not just one test: any call through the real
    // service functions (approveDocument/rejectDocument) enqueues onto the
    // real, shared Redis-backed queue regardless of which test triggers it.
    // Without a worker running throughout, a job from an earlier test sits
    // unconsumed and gets picked up later, contaminating whichever test
    // happens to start a worker next -- this bit us once already.
    const { createWebhookWorker } = await import('../../src/workers/webhook.worker.js');
    webhookWorker = createWebhookWorker();
  });

  afterEach(() => {
    receivedRequests = [];
    receiverBehavior = 'success';
  });

  afterAll(async () => {
    await webhookWorker?.close();
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    const { closeRedis } = await import('../../src/lib/redis.js');
    await closeRedis();
  });

  async function createApprovedDocument(): Promise<string> {
    const documentId = randomUUID();
    await withTenantContext(tenantId, async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        tenantId,
        uploadedBy: adminUserId,
        status: 'approved',
        docType: 'invoice',
        storageKey: `${tenantId}/${documentId}/test.pdf`,
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      });
    });
    return documentId;
  }

  it('delivers a signed payload to the configured URL and records a success delivery', async () => {
    const documentId = await createApprovedDocument();

    const result = await processWebhookJob({ data: { documentId, tenantId } } as any);
    expect(result.status).toBe('success');

    expect(receivedRequests).toHaveLength(1);
    const [received] = receivedRequests;
    expect(received.headers['x-webhook-event']).toBe('document.approved');

    const expectedSignature = signWebhookBody(received.body, webhookSecret);
    expect(received.headers['x-webhook-signature']).toBe(expectedSignature);

    const payload = JSON.parse(received.body);
    expect(payload).toMatchObject({ event: 'document.approved', documentId, tenantId, status: 'approved' });

    const rows = await withTenantContext(tenantId, async (tx) => tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.documentId, documentId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].responseStatus).toBe(200);
    expect(rows[0].deliveredAt).not.toBeNull();

    const auditRows = await withTenantContext(tenantId, async (tx) => tx.select().from(documentAuditLog).where(eq(documentAuditLog.documentId, documentId)));
    expect(auditRows.some((r) => r.event === 'webhook_sent')).toBe(true);
  });

  it('signs a tampered body incorrectly -- verifying with a different secret does not match', async () => {
    const documentId = await createApprovedDocument();
    await processWebhookJob({ data: { documentId, tenantId } } as any);

    const [received] = receivedRequests;
    const wrongSignature = signWebhookBody(received.body, 'a-completely-different-secret');
    expect(received.headers['x-webhook-signature']).not.toBe(wrongSignature);
  });

  it('escalates to dead_letter after exhausting attempts, without ever succeeding', async () => {
    receiverBehavior = 'fail';
    const documentId = await createApprovedDocument();

    // Direct, repeated calls simulate BullMQ's own retries without waiting
    // through real exponential backoff delays -- attempt numbering and
    // dead-letter escalation are derived from DB row count, not from
    // BullMQ's internal counters, so this is a faithful test of the same
    // logic the real worker uses.
    const r1 = await processWebhookJob({ data: { documentId, tenantId } } as any).catch((e) => e);
    expect(r1).toBeInstanceOf(Error); // attempt 1/3 -- not final, throws to signal "retry me"

    const r2 = await processWebhookJob({ data: { documentId, tenantId } } as any).catch((e) => e);
    expect(r2).toBeInstanceOf(Error); // attempt 2/3 -- still not final

    const r3 = await processWebhookJob({ data: { documentId, tenantId } } as any);
    expect(r3.status).toBe('dead_letter'); // attempt 3/3 -- final, does not throw

    const rows = await withTenantContext(tenantId, async (tx) => tx.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.documentId, documentId))
      .orderBy(webhookDeliveries.attempt));
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'dead_letter'],
    ]);
    expect(receivedRequests).toHaveLength(3);
  });

  it('skips cleanly (no delivery row) when the tenant has no webhook configured', async () => {
    const other = await AuthService.register({
      tenantName: 'No Webhook Co',
      tenantSlug: `${tenantSlug}-no-webhook`,
      email: `no-webhook-${suffix}@example.test`,
      password,
    });
    const documentId = randomUUID();
    await withTenantContext(other.tenant.id, async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        tenantId: other.tenant.id,
        uploadedBy: other.user.id,
        status: 'approved',
        docType: 'invoice',
        storageKey: `${other.tenant.id}/${documentId}/test.pdf`,
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      });
    });

    const result = await processWebhookJob({ data: { documentId, tenantId: other.tenant.id } } as any);
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not_configured');
    expect(receivedRequests).toHaveLength(0);

    await pool.query('DELETE FROM users WHERE tenant_id = $1', [other.tenant.id]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [other.tenant.id]);
  });

  it('a rejected document webhook includes the rejection reason from the audit log', async () => {
    const documentId = randomUUID();
    await withTenantContext(tenantId, async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        tenantId,
        uploadedBy: adminUserId,
        status: 'pending_review',
        docType: 'invoice',
        storageKey: `${tenantId}/${documentId}/test.pdf`,
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      });
    });

    await DocumentService.rejectDocument({
      tenantId,
      documentId,
      actorId: adminUserId,
      reason: 'Line items do not match the stated subtotal',
    });

    // rejectDocument's own enqueue goes through the real, always-running
    // worker started in beforeAll -- wait for its delivery rather than
    // calling the processor a second time ourselves (which would double
    // up: once via the real worker, once via our own direct call).
    const deadline = Date.now() + 8000;
    while (receivedRequests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(receivedRequests).toHaveLength(1);
    const payload = JSON.parse(receivedRequests[0].body);
    expect(payload.event).toBe('document.rejected');
    expect(payload.reason).toBe('Line items do not match the stated subtotal');
  }, 10_000);

  it('end-to-end: approving via the real HTTP route enqueues a real BullMQ job, delivered by the real worker', async () => {
    const documentId = randomUUID();
    await withTenantContext(tenantId, async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        tenantId,
        uploadedBy: adminUserId,
        status: 'pending_review',
        docType: 'invoice',
        storageKey: `${tenantId}/${documentId}/test.pdf`,
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      });
    });

    const { app } = await import('../../src/app.js');
    const request = (await import('supertest')).default;
    const res = await request(app)
      .post(`/api/v1/documents/${documentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const deadline = Date.now() + 8000;
    while (receivedRequests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(receivedRequests).toHaveLength(1);
    const payload = JSON.parse(receivedRequests[0].body);
    expect(payload).toMatchObject({ event: 'document.approved', documentId, tenantId });
  }, 15_000);
});
