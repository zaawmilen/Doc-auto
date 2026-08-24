import {Redis} from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const isTLS = env.REDIS_URL.startsWith("rediss://");
const isTest = process.env.NODE_ENV === "test";

// In tests we want deterministic behavior and NO reconnect loops
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: isTest ? 1 : 3,

  // CRITICAL: prevents hanging sockets in test runs
  enableOfflineQueue: false,

  lazyConnect: true,

  retryStrategy(times: number) {
    if (isTest) return null; // do NOT retry in tests (prevents hanging handles)
    if (times > 10) return null;
    return Math.min(times * 100, 2000);
  },

  reconnectOnError(err: Error) {
    if (isTest) return false; // prevent reconnect storms in tests
    return (
      err.message.includes("ECONNRESET") ||
      err.message.includes("ETIMEDOUT")
    );
  },

  ...(isTLS ? { tls: {} } : {}),
});

// Prevent noisy logging + dangling listeners in test mode
if (!isTest) {
  redis.on("connect", () => logger.info("Redis connected"));
  redis.on("ready", () => logger.debug("Redis ready"));
  redis.on("error", (err: unknown) => {
    const code = (err as any)?.code as string | undefined;
    if (code !== "ECONNRESET") {
      logger.error({ err }, "Redis error");
    }
  });
  redis.on("close", () => logger.warn("Redis connection closed"));
  redis.on("reconnecting", () => logger.warn("Redis reconnecting"));
}

// ---- CORE EXPORT ----
export { redis };

// ---- HEALTH CHECK ----
export async function checkRedisConnection(): Promise<void> {
  const pong = await redis.ping();
  if (pong !== "PONG") {
    throw new Error(`Unexpected Redis ping response: ${pong}`);
  }
}

// ---- CLEAN SHUTDOWN (IMPORTANT FOR VITEST) ----
export async function closeRedis(): Promise<void> {
  try {
    await redis.flushall(); // optional but helps tests stay deterministic
    await redis.quit();
  } catch (err) {
    logger.warn({ err }, "Redis quit failed, forcing disconnect");
  } finally {
    // HARD KILL lingering sockets
    (redis as any).disconnect?.();
  }

  logger.info("Redis connection closed");
}