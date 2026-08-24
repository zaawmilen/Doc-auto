import type { Request, Response, NextFunction } from 'express';
import { httpRequestDurationSeconds, httpRequestsTotal } from '../lib/metrics.js';

function routeLabel(req: Request): string {
  return req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
}

export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const route = routeLabel(req);
    httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
    httpRequestDurationSeconds.observe({ method: req.method, route }, durationSeconds);
  });
  next();
}