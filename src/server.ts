import 'dotenv/config';
import http from 'http';

import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { closeDatabasePool } from './db/index.js';
import { ocrQueue, extractionQueue, webhookQueue } from './queues/index.js';

async function bootstrap() {
  await redis.connect();
  logger.info('Redis connected');

  const httpServer = http.createServer(app);

  httpServer.listen(env.PORT, '0.0.0.0', () => {
    logger.info({ port: env.PORT }, 'Server running');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received — draining');

    const openSockets = new Set<import('net').Socket>();
    httpServer.on('connection', (socket) => {
      openSockets.add(socket);
      socket.once('close', () => openSockets.delete(socket));
    });

    httpServer.close(async () => {
      logger.info('HTTP server closed — shutting down subsystems');
      try {
        await Promise.all([
          closeDatabasePool(),
          redis.quit?.() ?? redis.disconnect?.(),
          ocrQueue.close(),
          extractionQueue.close(),
          webhookQueue.close(),
        ]);
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });

    for (const socket of openSockets) socket.destroy();

    setTimeout(() => {
      logger.error('Shutdown timeout — forcing exit');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
