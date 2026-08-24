import { Router, Request, Response } from 'express';
import { checkDatabaseConnection } from '../db/index.js';
import { checkRedisConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

router.get('/readyz', async (req: Request, res: Response) => {
  const checks: Record<string, 'ok' | 'error'> = {};
  let allHealthy = true;

  const [dbResult, redisResult] = await Promise.allSettled([
    checkDatabaseConnection(),
    checkRedisConnection(),
  ]);

  if (dbResult.status === 'fulfilled') {
    checks.database = 'ok';
  } else {
    checks.database = 'error';
    allHealthy = false;
    logger.error({ err: dbResult.reason, correlationId: req.correlationId }, 'DB unhealthy');
  }

  if (redisResult.status === 'fulfilled') {
    checks.redis = 'ok';
  } else {
    checks.redis = 'error';
    allHealthy = false;
    logger.error({ err: redisResult.reason, correlationId: req.correlationId }, 'Redis unhealthy');
  }

  return res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  });
});

export { router as healthRouter };
