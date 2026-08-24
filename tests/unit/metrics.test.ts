import { describe, expect, it } from 'vitest';
import { httpRequestsTotal, metricsRegistry } from '../../src/lib/metrics.js';

describe('Prometheus metrics', () => {
  it('registers bounded HTTP request metrics', async () => {
    httpRequestsTotal.inc({ method: 'GET', route: '/healthz', status: '200' });

    const output = await metricsRegistry.metrics();

    expect(output).toContain('docauto_http_requests_total');
    expect(output).toContain('route="/healthz"');
  });
});