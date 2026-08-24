import { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

type AuthenticatedRequest = Request & {
  user?: {
    sub?: string;
  };
};

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local window_ms = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

local count = redis.call('ZCARD', key)

if count >= limit then
  return {0, count}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms)

return {1, count + 1}
`;

async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{
  allowed: boolean;
  count: number;
}> {
  const now = Date.now();
  const windowStart = now - windowMs;

  const member = `${now}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const result = (await redis.eval(
    SLIDING_WINDOW_SCRIPT,
    1,
    key,
    String(now),
    String(windowStart),
    String(limit),
    String(windowMs),
    member,
  )) as [number, number];

  return {
    allowed: result[0] === 1,
    count: result[1],
  };
}

export function rateLimiter(limit: number, windowMs: number) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      // Disable rate limiting during tests if desired
      if (
        process.env.NODE_ENV === "test" &&
        process.env.DISABLE_RATE_LIMITS === "true"
      ) {
        return next();
      }

      const identifier =
        req.user?.sub ||
        req.ip ||
        "anonymous";

      const routeKey = `${req.method}:${req.path}`;

      const key = `rate_limit:${routeKey}:${identifier}`;

      const { allowed, count } =
        await checkRateLimit(
          key,
          limit,
          windowMs,
        );

      const remaining = Math.max(
        0,
        limit - count,
      );

      res.setHeader(
        "X-RateLimit-Limit",
        String(limit),
      );

      res.setHeader(
        "X-RateLimit-Remaining",
        String(remaining),
      );

      res.setHeader(
        "X-RateLimit-Window-Ms",
        String(windowMs),
      );

      if (!allowed) {
        const retryAfterSeconds = Math.ceil(
          windowMs / 1000,
        );

        res.setHeader(
          "Retry-After",
          String(retryAfterSeconds),
        );

        logger.warn(
          {
            identifier,
            routeKey,
          },
          "Rate limit exceeded",
        );

        return res.status(429).json({
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message:
              "Too many requests. Please try again later.",
            retryAfterSeconds,
          },
        });
      }

      next();
    } catch (err) {
      logger.error(
        { err },
        "Rate limiter error (fail open)",
      );

      // fail open
      return next();
    }
  };
}

/*
|--------------------------------------------------------------------------
| Profiles
|--------------------------------------------------------------------------
*/

// Global API limit — per user/IP across all routes
export const apiRateLimit = rateLimiter(120, 60_000);

// Auth endpoints — tighter to slow brute-force
export const authRateLimit = rateLimiter(10, 15 * 60_000);

// Per-user-per-auction bid limit: 10 bids per auction per 60s
// Key: rate_limit:POST:/auctions/:id/bids:<userId>
// Prevents bid spamming on a single auction
export const bidRateLimit = rateLimiter(10, 60_000);

// Per-user GLOBAL bid limit: 30 bids across ALL auctions per 60s
// Separate key using a fixed route string so all auctions share one bucket.
// This catches bot behaviour that spreads bids across many auctions.
export async function globalUserBidRateLimit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (
      process.env.NODE_ENV === 'test' &&
      process.env.DISABLE_RATE_LIMITS === 'true'
    ) {
      return next();
    }

    const identifier = req.user?.sub ?? req.ip ?? 'anonymous';
    // Fixed key — all auction bid routes share one global bucket per user
    const key = `rate_limit:global_bids:${identifier}`;
    const limit = 30;
    const windowMs = 60_000;

    const { allowed, count } = await checkRateLimit(key, limit, windowMs);
    const remaining = Math.max(0, limit - count);

    res.setHeader('X-RateLimit-Global-Limit',     String(limit));
    res.setHeader('X-RateLimit-Global-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Window-Ms',        String(windowMs));

    if (!allowed) {
      const retryAfterSeconds = Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      logger.warn({ identifier }, 'Global bid rate limit exceeded');
      res.status(429).json({
        error: {
          code:               'RATE_LIMIT_EXCEEDED',
          message:            'Too many bids across auctions. Please try again later.',
          retryAfterSeconds,
        },
      });
      return;
    }

    next();
  } catch (err) {
    logger.error({ err }, 'Global bid rate limiter error (fail open)');
    next();
  }
}