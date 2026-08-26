import { Worker, Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { withTenantContext } from '../db/index.js';
import { documents, documentsExtraction, tenants } from '../db/schema.js';
import { getQueueConnection } from '../queues/index.js';
import type { ExtractionJob } from '../queues/index.js';
import { webhookQueue } from '../queues/index.js';
import { classifyDocument, extractInvoice } from '../lib/anthropic.js';
import { evaluateExtraction } from '../lib/decision-engine.js';
import { writeAuditLog } from '../services/audit.service.js';
import { logger } from '../lib/logger.js';
import { workerJobDurationSeconds, workerJobsTotal } from '../lib/metrics.js';
import { queueJobsEnqueuedTotal } from '../lib/metrics.js';

export function createExtractionWorker() {
  const connection = getQueueConnection();

  const worker = new Worker<ExtractionJob>(
    'extraction-jobs',
    async (job: Job<ExtractionJob>) => {
      const { documentId, tenantId } = job.data;

      const document = await withTenantContext(tenantId, async (tx) => tx.query.documents.findFirst({
        where: eq(documents.id, documentId),
        with: { extraction: true },
      }));
      if (!document) {
        logger.warn({ documentId }, '[Extraction] Document not found, skipping job');
        return { documentId, status: 'skipped' };
      }

      if (document.extraction && ['approved', 'pending_review'].includes(document.status)) {
        logger.info({ documentId, status: document.status }, '[Extraction] Terminal document already processed, skipping duplicate job');
        return { documentId, status: 'skipped', reason: 'already_processed' };
      }

      if (!document.rawText || document.rawText.trim().length === 0) {
        await withTenantContext(tenantId, async (tx) => {
          await tx.update(documents).set({ status: 'failed', updatedAt: new Date() }).where(eq(documents.id, documentId));
        });
        await writeAuditLog({
          tenantId,
          documentId,
          event: 'extracted',
          prevStatus: document.status,
          newStatus: 'failed',
          payload: { error: 'OCR returned no text -- nothing to classify or extract' },
        });
        logger.error({ documentId }, '[Extraction] Hard fail - empty raw_text');
        return { documentId, status: 'failed', reason: 'empty_raw_text' };
      }

      const tenant = await withTenantContext(tenantId, async (tx) => tx.query.tenants.findFirst({
        where: eq(tenants.id, tenantId),
      }));
      const threshold = tenant ? Number(tenant.extractionThreshold) : 0.85;

      await withTenantContext(tenantId, async (tx) => {
        await tx.update(documents).set({ status: 'extracting', updatedAt: new Date() }).where(eq(documents.id, documentId));
      });

      try {
        const classification = await classifyDocument(document.rawText, { documentId });
        logger.info({ documentId, classification }, '[Extraction] Classification complete');

        if (classification.docType === 'unknown') {
          await withTenantContext(tenantId, async (tx) => {
            await tx.update(documents).set({
              status: 'pending_review',
              docType: 'unknown',
              updatedAt: new Date(),
            }).where(eq(documents.id, documentId));
          });

          await writeAuditLog({
            tenantId,
            documentId,
            event: 'sent_to_review',
            prevStatus: 'extracting',
            newStatus: 'pending_review',
            payload: { reason: 'doc_type = unknown', classification },
          });

          logger.info({ documentId }, '[Extraction] Unknown doc type - routed to review without extraction');
          return { documentId, status: 'pending_review', reason: 'unknown_doc_type' };
        }

        await withTenantContext(tenantId, async (tx) => {
          await tx.update(documents).set({ docType: classification.docType, updatedAt: new Date() }).where(eq(documents.id, documentId));
        });

        const extractionResult = await extractInvoice(document.rawText, { documentId });
        const { extraction, llmModel, inputTokens, outputTokens } = extractionResult;

        await withTenantContext(tenantId, async (tx) => {
          await tx.insert(documentsExtraction).values({
            documentId,
            vendorName: extraction.vendor.name,
            vendorAddress: extraction.vendor.address,
            vendorTaxId: extraction.vendor.taxId,
            invoiceNumber: extraction.invoice.number,
            invoiceDate: extraction.invoice.date,
            dueDate: extraction.invoice.dueDate,
            subtotal: extraction.totals.subtotal.toFixed(2),
            tax: extraction.totals.tax.toFixed(2),
            total: extraction.totals.total.toFixed(2),
            confidenceScores: extraction.confidence,
            lineItems: extraction.lineItems,
            llmModel,
            inputTokens,
            outputTokens,
          }).onConflictDoNothing({ target: documentsExtraction.documentId });
        });

        const decision = evaluateExtraction(extraction, threshold);
        logger.info({ documentId, decision }, '[Extraction] Decision engine result');

        if (decision.decision === 'auto_approve') {
          await withTenantContext(tenantId, async (tx) => {
            await tx.update(documents).set({ status: 'approved', updatedAt: new Date() }).where(eq(documents.id, documentId));
          });
          await writeAuditLog({
            tenantId,
            documentId,
            event: 'extracted',
            prevStatus: 'extracting',
            newStatus: 'approved',
            payload: { llmModel, inputTokens, outputTokens, minConfidence: decision.minConfidence },
          });
          await writeAuditLog({
            tenantId,
            documentId,
            event: 'auto_approved',
            prevStatus: 'approved',
            newStatus: 'approved',
            payload: { threshold, minConfidence: decision.minConfidence, lineItemsSum: decision.lineItemsSum },
          });
          if (tenant?.webhookUrl) {
            await webhookQueue.add('webhook', { documentId, tenantId });
            queueJobsEnqueuedTotal.inc({ queue: 'webhook-jobs' });
          }
        } else {
          await withTenantContext(tenantId, async (tx) => {
            await tx.update(documents).set({ status: 'pending_review', updatedAt: new Date() }).where(eq(documents.id, documentId));
          });
          await writeAuditLog({
            tenantId,
            documentId,
            event: 'extracted',
            prevStatus: 'extracting',
            newStatus: 'pending_review',
            payload: { llmModel, inputTokens, outputTokens, minConfidence: decision.minConfidence },
          });
          await writeAuditLog({
            tenantId,
            documentId,
            event: 'sent_to_review',
            prevStatus: 'pending_review',
            newStatus: 'pending_review',
            payload: { reasons: decision.reasons },
          });
        }

        return { documentId, status: decision.decision === 'auto_approve' ? 'approved' : 'pending_review', decision };
      } catch (err) {
        await withTenantContext(tenantId, async (tx) => {
          await tx.update(documents).set({ status: 'failed', updatedAt: new Date() }).where(eq(documents.id, documentId));
        });
        await writeAuditLog({
          tenantId,
          documentId,
          event: 'extracted',
          prevStatus: 'extracting',
          newStatus: 'failed',
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
        logger.error({ documentId, err }, '[Extraction] Hard fail');
        throw err;
      }
    },
    { connection, concurrency: 2, drainDelay: 5000 },
  );

  worker.on('completed', (job, result) => {
    workerJobsTotal.inc({ queue: 'extraction-jobs', status: 'completed' });
    if (job.processedOn && job.finishedOn) workerJobDurationSeconds.observe({ queue: 'extraction-jobs', status: 'completed' }, (job.finishedOn - job.processedOn) / 1000);
    logger.info({ jobId: job.id, result }, 'Extraction job completed');
  });
  worker.on('failed', (job, err) => {
    workerJobsTotal.inc({ queue: 'extraction-jobs', status: 'failed' });
    if (job?.processedOn && job.finishedOn) workerJobDurationSeconds.observe({ queue: 'extraction-jobs', status: 'failed' }, (job.finishedOn - job.processedOn) / 1000);
    logger.error({ jobId: job?.id, err }, 'Extraction job failed');
  });
  return worker;
}
