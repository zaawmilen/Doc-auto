import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { signWebhookBody } from '../../src/lib/webhooks.js';

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration('tenant config route', () => {
  let app: typeof import('../../src/app.js').app;
  let AuthService: typeof import('../../src/services/auth.service.js');
  let DocumentService: typeof import('../../src/services/document.service.js');
  let pool: typeof import('../../src/db/index.js').pool;
  let withTenantContext: typeof import('../../src/db/index.js').withTenantContext;
  let documents: typeof import('../../src/db/schema.js').documents;
  let redis: typeof import('../../src/lib/redis.js').redis;

  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `tenant-cfg-test-${suffix}`;
  const adminEmail = `tenant-cfg-admin-${suffix}@example.test`;
  const viewerEmail = `tenant-cfg-viewer-${suffix}@example.test`;
  const password = 'correct-horse-battery-staple';

  let tenantId: string;
  let adminUserId: string;
  let adminToken: string;
  let viewerToken: string;
  let receiverServer: Server;
  let receiverUrl: string;
  let receivedRequests: Array<{ headers: http.IncomingHttpHeaders; body: string }>;

  beforeAll(async () => {
    ({ app } = await import('../../src/app.js'));
    AuthService = await import('../../src/services/auth.service.js');
    DocumentService = await import('../../src/services/document.service.js');
    ({ pool, withTenantContext } = await import('../../src/db/index.js'));
    ({ documents } = await import('../../src/db/schema.js'));
    ({ redis } = await import('../../src/lib/redis.js'));
    if (redis.status !== 'ready') await redis.connect();

    receivedRequests = [];
    receiverServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
    const addr = receiverServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to start test webhook receiver');
    receiverUrl = `http://127.0.0.1:${addr.port}/webhook`;

    const admin = await AuthService.register({ tenantName: 'Tenant Config Test Co', tenantSlug, email: adminEmail, password });
    tenantId = admin.tenant.id;
    adminUserId = admin.user.id;
    adminToken = (await AuthService.login({ email: adminEmail, password })).accessToken;

    const { withTenantContext: wtc } = await import('../../src/db/index.js');
    const { users } = await import('../../src/db/schema.js');
    const { hashPassword } = await import('../../src/lib/password.js');
    await wtc(tenantId, async (tx) => {
      await tx.insert(users).values({ tenantId, email: viewerEmail, passwordHash: await hashPassword(password), role: 'viewer' });
    });
    viewerToken = (await AuthService.login({ email: viewerEmail, password })).accessToken;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    const { closeRedis } = await import('../../src/lib/redis.js');
    await closeRedis();
  });

  it('GET returns defaults for a freshly registered tenant', async () => {
    const res = await request(app).get('/api/v1/tenant').set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({
      id: tenantId,
      slug: tenantSlug,
      extractionThreshold: 0.85,
      webhookUrl: null,
      webhookSecretConfigured: false,
    });
  });

  it('a viewer can read but not update tenant config', async () => {
    const res = await request(app)
      .patch('/api/v1/tenant')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ extractionThreshold: 0.5 });
    expect(res.status).toBe(403);
  });

  it('rejects an out-of-range extraction threshold', async () => {
    const res = await request(app)
      .patch('/api/v1/tenant')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ extractionThreshold: 1.5 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-URL webhookUrl', async () => {
    const res = await request(app)
      .patch('/api/v1/tenant')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ webhookUrl: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty update body', async () => {
    const res = await request(app)
      .patch('/api/v1/tenant')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('an admin updates the extraction threshold, and it is reflected on the next GET', async () => {
    const patchRes = await request(app)
      .patch('/api/v1/tenant')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ extractionThreshold: 0.5 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.tenant.extractionThreshold).toBe(0.5);

    const getRes = await request(app).get('/api/v1/tenant').set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.body.tenant.extractionThreshold).toBe(0.5);
  });

  it('rotating a webhook secret before a webhookUrl is set is rejected', async () => {
    const res = await request(app)
      .post('/api/v1/tenant/webhook-secret/rotate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_URL_NOT_CONFIGURED');
  });

  it('sets a webhookUrl, rotates a secret, and the secret is never returned again on GET', async () => {
    await request(app)
      .patch('/api/v1/tenant')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ webhookUrl: receiverUrl });

    const rotateRes = await request(app)
      .post('/api/v1/tenant/webhook-secret/rotate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    const getRes = await request(app).get('/api/v1/tenant').set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.body.tenant.webhookSecretConfigured).toBe(true);
    expect(getRes.body.tenant.webhookSecret).toBeUndefined();
  });

  it('the rotated secret is what the webhook worker actually signs deliveries with', async () => {
    // Not just checking DB state -- proving the real worker path uses
    // exactly this secret, the same way tests/integration/webhook-worker.test.ts
    // proves signing in general.
    const rotateRes = await request(app)
      .post('/api/v1/tenant/webhook-secret/rotate')
      .set('Authorization', `Bearer ${adminToken}`);
    const newSecret = rotateRes.body.webhookSecret as string;

    const { createWebhookWorker } = await import('../../src/workers/webhook.worker.js');
    const worker = createWebhookWorker();
    try {
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

      receivedRequests = [];
      const approveRes = await request(app)
        .post(`/api/v1/documents/${documentId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(approveRes.status).toBe(200);

      const deadline = Date.now() + 8000;
      while (receivedRequests.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(receivedRequests).toHaveLength(1);
      const [received] = receivedRequests;
      expect(received.headers['x-webhook-signature']).toBe(signWebhookBody(received.body, newSecret));
    } finally {
      await worker.close();
    }
  }, 15_000);

  it('clearing the webhookUrl also clears the configured secret', async () => {
    const patchRes = await request(app)
      .patch('/api/v1/tenant')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ webhookUrl: null });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.tenant.webhookUrl).toBeNull();
    expect(patchRes.body.tenant.webhookSecretConfigured).toBe(false);
  });
});
