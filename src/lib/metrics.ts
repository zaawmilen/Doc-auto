import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestsTotal = new Counter({
  name: 'docauto_http_requests_total',
  help: 'Total HTTP requests handled by the API',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'docauto_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

export const workerJobsTotal = new Counter({
  name: 'docauto_worker_jobs_total',
  help: 'Total worker jobs completed or failed',
  labelNames: ['queue', 'status'] as const,
  registers: [metricsRegistry],
});

export const workerJobDurationSeconds = new Histogram({
  name: 'docauto_worker_job_duration_seconds',
  help: 'Worker job duration in seconds',
  labelNames: ['queue', 'status'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

export const queueJobsEnqueuedTotal = new Counter({
  name: 'docauto_queue_jobs_enqueued_total',
  help: 'Total jobs enqueued by queue',
  labelNames: ['queue'] as const,
  registers: [metricsRegistry],
});

export const queueJobs = new Gauge({
  name: 'docauto_queue_jobs',
  help: 'Current BullMQ jobs by queue and state',
  labelNames: ['queue', 'state'] as const,
  registers: [metricsRegistry],
});

export const providerCallsTotal = new Counter({
  name: 'docauto_provider_calls_total',
  help: 'Total OCR and LLM provider calls',
  labelNames: ['provider', 'operation', 'status'] as const,
  registers: [metricsRegistry],
});

export const providerTokensTotal = new Counter({
  name: 'docauto_provider_tokens_total',
  help: 'Total provider tokens consumed',
  labelNames: ['provider', 'direction'] as const,
  registers: [metricsRegistry],
});

export const documentsByStatus = new Gauge({
  name: 'docauto_documents_by_status',
  help: 'Document status observations from completed processing jobs',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export function observeProviderCall(provider: string, operation: string, status: 'success' | 'error') {
  providerCallsTotal.inc({ provider, operation, status });
}

export function observeProviderTokens(inputTokens: number, outputTokens: number) {
  providerTokensTotal.inc({ provider: 'anthropic', direction: 'input' }, inputTokens);
  providerTokensTotal.inc({ provider: 'anthropic', direction: 'output' }, outputTokens);
}

export function setQueueJobCounts(queue: string, counts: Record<string, number>) {
  for (const [state, value] of Object.entries(counts)) {
    queueJobs.set({ queue, state }, value);
  }
}