import { Worker, Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { withTenantContext } from '../db/index.js';
import { documents } from '../db/schema.js';
import { getQueueConnection } from '../queues/index.js';
import type { OcrJob } from '../queues/index.js';
import { downloadDocument } from '../lib/storage.js';
import { extractText } from '../lib/textract.js';
import { writeAuditLog } from '../services/audit.service.js';
import { logger } from '../lib/logger.js';
import { extractionQueue } from '../queues/index.js';
import { extractionJobId } from '../queues/jobIds.js';
import { queueJobsEnqueuedTotal, workerJobDurationSeconds, workerJobsTotal } from '../lib/metrics.js';

export function createOcrWorker() {
  const connection = getQueueConnection();

  const worker = new Worker<OcrJob>(
    'ocr-jobs',
    async (job: Job<OcrJob>) => {
      const { documentId, tenantId, processingRunId = 'initial' } = job.data;

      const document = await withTenantContext(tenantId, async (tx) => tx.query.documents.findFirst({
        where: eq(documents.id, documentId),
      }));
      if (!document) {
        logger.warn({ documentId }, '[OCR] Document not found, skipping job');
        return { documentId, status: 'skipped' };
      }

      logger.info({ documentId, fileName: document.fileName }, '[OCR] Starting text detection');

      await withTenantContext(tenantId, async (tx) => {
        await tx.update(documents)
          .set({ status: 'ocr_processing', updatedAt: new Date() })
          .where(eq(documents.id, documentId));
      });

      try {
        const fileBuffer = await downloadDocument(document.storageKey);
        const { rawText, blockCount } = await extractText(fileBuffer, document.fileName, { documentId });

        await withTenantContext(tenantId, async (tx) => {
          await tx.update(documents)
            .set({ status: 'extracted', rawText, updatedAt: new Date() })
            .where(eq(documents.id, documentId));
        });

        await writeAuditLog({
          tenantId,
          documentId,
          event: 'ocr_complete',
          prevStatus: 'ocr_processing',
          newStatus: 'extracted',
          payload: { blockCount, textLength: rawText.length },
        });

        logger.info({ documentId, textLength: rawText.length }, '[OCR] Complete, raw_text stored');

        await extractionQueue.add(
          'extract',
          { documentId, tenantId: document.tenantId, processingRunId },
          { jobId: extractionJobId(documentId, processingRunId) },
        );
        queueJobsEnqueuedTotal.inc({ queue: 'extraction-jobs' });
        logger.info({ documentId }, '[OCR] Extraction job enqueued');

        return { documentId, status: 'extracted', textLength: rawText.length };
      } catch (err) {
        await withTenantContext(tenantId, async (tx) => {
          await tx.update(documents)
            .set({ status: 'failed', updatedAt: new Date() })
            .where(eq(documents.id, documentId));
        });
        logger.error({ documentId, err }, '[OCR] Failed');
        throw err;
      }
    },
    { connection, concurrency: 3, drainDelay: 5000 },
  );

  worker.on('completed', (job, result) => {
    workerJobsTotal.inc({ queue: 'ocr-jobs', status: 'completed' });
    if (job.processedOn && job.finishedOn) workerJobDurationSeconds.observe({ queue: 'ocr-jobs', status: 'completed' }, (job.finishedOn - job.processedOn) / 1000);
    logger.info({ jobId: job.id, result }, 'OCR job completed');
  });
  worker.on('failed', (job, err) => {
    workerJobsTotal.inc({ queue: 'ocr-jobs', status: 'failed' });
    if (job?.processedOn && job.finishedOn) workerJobDurationSeconds.observe({ queue: 'ocr-jobs', status: 'failed' }, (job.finishedOn - job.processedOn) / 1000);
    logger.error({ jobId: job?.id, err }, 'OCR job failed');
  });
  return worker;
}
