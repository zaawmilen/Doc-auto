import { Queue } from 'bullmq';
import { env } from '../config/env.js';

export function getQueueConnection() {
  const url = new URL(env.REDIS_URL);
  const isTLS = env.REDIS_URL.startsWith('rediss://');
  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (times: number) => Math.min(times * 100, 3000),
    ...(isTLS && { tls: {} }),
  };
}

const connection = getQueueConnection();
const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
};

export const ocrQueue = new Queue('ocr-jobs', { connection, defaultJobOptions });
export const extractionQueue = new Queue('extraction-jobs', { connection, defaultJobOptions });
// Week 7-8 — declared now so document.service.ts / approval endpoints can enqueue
// onto it once the webhook delivery worker lands, without a queue-wiring change later.
export const webhookQueue = new Queue('webhook-jobs', { connection, defaultJobOptions });

export interface OcrJob {
  documentId: string;
  tenantId: string;
  processingRunId?: string;
  _correlationId?: string;
}

export interface ExtractionJob {
  documentId: string;
  tenantId: string;
  processingRunId?: string;
  _correlationId?: string;
}

export interface WebhookJob {
  documentId: string;
  tenantId: string;
  attempt?: number;
  _correlationId?: string;
}
