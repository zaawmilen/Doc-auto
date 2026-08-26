import { Worker, Job } from 'bullmq';
import { count, desc, eq } from 'drizzle-orm';
import { withTenantContext } from '../db/index.js';
import { documentAuditLog, documents, tenants, webhookDeliveries } from '../db/schema.js';
import { getQueueConnection, WEBHOOK_MAX_ATTEMPTS } from '../queues/index.js';
import type { WebhookJob } from '../queues/index.js';
import { signWebhookBody } from '../lib/webhooks.js';
import type { WebhookPayload } from '../lib/webhooks.js';
import { writeAuditLog } from '../services/audit.service.js';
import { logger } from '../lib/logger.js';
import { workerJobDurationSeconds, workerJobsTotal } from '../lib/metrics.js';

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_CHARS = 2000;

/**
 * Attempt numbering and dead-letter escalation are derived entirely from how
 * many webhook_deliveries rows already exist for this document, not from
 * BullMQ's own job.attemptsMade counter. This keeps the retry/dead-letter
 * decision fully within application state (easy to reason about and to test
 * by calling this function directly, repeatedly, without needing BullMQ's
 * real backoff delays to elapse) rather than depending on the queue
 * library's internal retry bookkeeping.
 */
export async function processWebhookJob(job: Job<WebhookJob>) {
  const { documentId, tenantId } = job.data;

  const { document, tenant } = await withTenantContext(tenantId, async (tx) => {
    const document = await tx.query.documents.findFirst({
      where: eq(documents.id, documentId),
      with: { extraction: true },
    });
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    return { document, tenant };
  });

  if (!document || !tenant) {
    logger.warn({ documentId, tenantId }, '[Webhook] Document or tenant not found, skipping job');
    return { documentId, status: 'skipped', reason: 'not_found' };
  }
  if (!tenant.webhookUrl || !tenant.webhookSecret) {
    logger.info({ documentId, tenantId }, '[Webhook] No webhook configured for tenant, skipping');
    return { documentId, status: 'skipped', reason: 'not_configured' };
  }
  if (document.status !== 'approved' && document.status !== 'rejected') {
    logger.warn({ documentId, status: document.status }, '[Webhook] Document is not in a terminal state, skipping');
    return { documentId, status: 'skipped', reason: 'not_terminal' };
  }

  const existingAttempts = await withTenantContext(tenantId, async (tx) => {
    const rows = await tx.select({ value: count() }).from(webhookDeliveries).where(eq(webhookDeliveries.documentId, documentId));
    return rows[0]?.value ?? 0;
  });
  const attempt = existingAttempts + 1;
  const isFinalAttempt = attempt >= WEBHOOK_MAX_ATTEMPTS;

  let payload: WebhookPayload;
  if (document.status === 'approved') {
    payload = {
      event: 'document.approved',
      documentId,
      tenantId,
      status: 'approved',
      docType: document.docType,
      timestamp: new Date().toISOString(),
      ...(document.extraction
        ? {
            extraction: {
              vendorName: document.extraction.vendorName,
              invoiceNumber: document.extraction.invoiceNumber,
              total: document.extraction.total,
            },
          }
        : {}),
    };
  } else {
    const rejectionEvent = await withTenantContext(tenantId, async (tx) => {
      const rows = await tx.select().from(documentAuditLog)
        .where(eq(documentAuditLog.documentId, documentId))
        .orderBy(desc(documentAuditLog.createdAt));
      return rows.find((r) => r.event === 'rejected');
    });
    const reason = (rejectionEvent?.payload as { reason?: string } | null)?.reason;
    payload = {
      event: 'document.rejected',
      documentId,
      tenantId,
      status: 'rejected',
      docType: document.docType,
      timestamp: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
  }

  const bodyString = JSON.stringify(payload);
  const signature = signWebhookBody(bodyString, tenant.webhookSecret);

  const deliveryId = await withTenantContext(tenantId, async (tx) => {
    const [row] = await tx.insert(webhookDeliveries).values({
      documentId,
      tenantId,
      status: 'pending',
      attempt,
    }).returning({ id: webhookDeliveries.id });
    if (!row) throw new Error('Failed to insert webhook_deliveries row');
    return row.id;
  });

  let responseStatus: number | null = null;
  let responseBodyText: string | null = null;
  let deliveryError: string | null = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(tenant.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': payload.event,
        'X-Webhook-Signature': signature,
      },
      body: bodyString,
      signal: controller.signal,
    });
    responseStatus = res.status;
    responseBodyText = (await res.text().catch(() => '')).slice(0, MAX_RESPONSE_BODY_CHARS);
    if (!res.ok) deliveryError = `Non-2xx response: ${res.status}`;
  } catch (err) {
    deliveryError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }

  const succeeded = !deliveryError;

  await withTenantContext(tenantId, async (tx) => {
    await tx.update(webhookDeliveries)
      .set({
        status: succeeded ? 'success' : isFinalAttempt ? 'dead_letter' : 'failed',
        responseStatus,
        responseBody: responseBodyText ?? deliveryError,
        deliveredAt: succeeded ? new Date() : null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
  });

  if (succeeded) {
    await writeAuditLog({
      tenantId,
      documentId,
      event: 'webhook_sent',
      payload: { attempt, responseStatus },
    });
    return { documentId, status: 'success', attempt };
  }

  await writeAuditLog({
    tenantId,
    documentId,
    event: 'webhook_failed',
    payload: { attempt, isFinalAttempt, error: deliveryError, responseStatus },
  });

  if (isFinalAttempt) {
    logger.error({ documentId, tenantId, attempt, deliveryError }, '[Webhook] Delivery exhausted retries, marked dead_letter');
    return { documentId, status: 'dead_letter', attempt };
  }

  // Not the final attempt — throw so BullMQ schedules a retry with backoff.
  throw new Error(`Webhook delivery failed (attempt ${attempt}/${WEBHOOK_MAX_ATTEMPTS}): ${deliveryError}`);
}

export function createWebhookWorker() {
  const connection = getQueueConnection();

  const worker = new Worker<WebhookJob>('webhook-jobs', processWebhookJob, {
    connection,
    concurrency: 2,
    drainDelay: 5000,
  });

  worker.on('completed', (job, result) => {
    workerJobsTotal.inc({ queue: 'webhook-jobs', status: 'completed' });
    if (job.processedOn && job.finishedOn) workerJobDurationSeconds.observe({ queue: 'webhook-jobs', status: 'completed' }, (job.finishedOn - job.processedOn) / 1000);
    logger.info({ jobId: job.id, result }, 'Webhook job completed');
  });
  worker.on('failed', (job, err) => {
    workerJobsTotal.inc({ queue: 'webhook-jobs', status: 'failed' });
    if (job?.processedOn && job.finishedOn) workerJobDurationSeconds.observe({ queue: 'webhook-jobs', status: 'failed' }, (job.finishedOn - job.processedOn) / 1000);
    logger.error({ jobId: job?.id, err }, 'Webhook job failed');
  });
  return worker;
}
