import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Assigns a stable fingerprint to an error for grouping in log aggregators.
 * Based on the error code + route — not the message (which can contain
 * dynamic values that would fragment groupings).
 */
function errorFingerprint(err: unknown, req: Request): string {
  const route  = `${req.method} ${req.route?.path ?? req.path}`;
  if (err instanceof AppError)  return `${err.code}::${route}`;
  if (err instanceof ZodError)  return `VALIDATION_ERROR::${route}`;
  if (err instanceof Error)     return `${err.name}::${route}`;
  return `UNKNOWN::${route}`;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // ── Zod validation errors ────────────────────────────────────────────────
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code:    'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({
          path:    i.path.join('.'),
          message: i.message,
        })),
      },
    });
    return;
  }

  // ── Known operational errors ─────────────────────────────────────────────
  if (err instanceof AppError && err.isOperational) {
    res.status(err.statusCode).json({
      error: {
        code:    err.code,
        message: err.message,
        ...(err.details !== undefined && { details: err.details }),
      },
    });
    return;
  }

  // ── Unexpected errors — log with full context ────────────────────────────
  const fingerprint = errorFingerprint(err, req);

  logger.error({
    err,
    fingerprint,
    correlationId: req.correlationId,
    method:        req.method,
    url:           req.url,
    // Stack is serialised by pino's err serializer automatically,
    // but we also pull it here for log aggregators that flatten fields.
    stack:         err instanceof Error ? err.stack : undefined,
  }, 'Unhandled error');

  // Never leak stack traces or internal details to the client in production.
  res.status(500).json({
    error: {
      code:    'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      // correlationId lets a user/support engineer cross-reference the log entry
      correlationId: req.correlationId,
    },
  });
}