import express from 'express';
import helmet from 'helmet';
import { correlationId } from './middleware/correlationId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiRateLimit } from './middleware/rateLimiter.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';
import { metricsRouter } from './routes/metrics.js';
import { requestMetrics } from './middleware/metrics.js';

export const app = express();

// ── Security headers ─────────────────────────────────────────────────────────
app.disable('x-powered-by');

app.use(helmet({
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  noSniff: true,
  frameguard: { action: 'deny' },
  xssFilter: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
// Multipart (file upload) is parsed by multer at the route level, not here.
app.use(express.json({ limit: '1mb' }));

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(correlationId);
app.use(requestLogger);
app.use(requestMetrics);

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use(healthRouter); // no rate limit — used by load balancers / Fly.io checks
app.use(metricsRouter);

app.use('/api/v1/auth', apiRateLimit, authRouter);
app.use('/api/v1/documents', apiRateLimit, documentsRouter);

// ── Error handler — must be last ─────────────────────────────────────────────
app.use(errorHandler);
