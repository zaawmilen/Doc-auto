import 'dotenv/config';
import { logger } from './lib/logger.js';
import { createOcrWorker } from './workers/ocr.worker.js';
import { createExtractionWorker } from './workers/extraction.worker.js';
import { createWebhookWorker } from './workers/webhook.worker.js';

async function startWorker() {
  logger.info('Starting worker process');
  const workers = [createOcrWorker(), createExtractionWorker(), createWebhookWorker()];
  logger.info({ queues: ['ocr-jobs', 'extraction-jobs', 'webhook-jobs'] }, 'All workers started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutdown signal received');
    await Promise.all(workers.map((w) => w.close()));
    logger.info('All workers closed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
}

startWorker().catch((err) => {
  logger.error({ err }, 'Failed to start worker');
  process.exit(1);
});
