import { Router, type Request, type Response, type NextFunction } from 'express';
import { env } from '../config/env.js';
import { metricsRegistry } from '../lib/metrics.js';
import { extractionQueue, ocrQueue, webhookQueue } from '../queues/index.js';
import { setQueueJobCounts } from '../lib/metrics.js';

const router = Router();

function requireMetricsToken(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Metrics authentication required' } });
    return;
  }
  next();
}

router.get('/metrics', requireMetricsToken, async (_req, res, next) => {
  try {
    const queues = [
      ['ocr-jobs', ocrQueue],
      ['extraction-jobs', extractionQueue],
      ['webhook-jobs', webhookQueue],
    ] as const;
    await Promise.all(queues.map(async ([name, queue]) => {
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      setQueueJobCounts(name, counts);
    }));
    res.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
  } catch (error) {
    next(error);
  }
});

export { router as metricsRouter };