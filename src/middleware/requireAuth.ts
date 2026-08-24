import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyAccessToken } from '../lib/jwt.js';
import { AppError } from '../lib/errors.js';

type AccessTokenPayload = ReturnType<typeof verifyAccessToken>;
const { JsonWebTokenError, TokenExpiredError } = jwt;

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Missing or invalid Authorization header'));
  }
  const token = authHeader.slice(7);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    if (err instanceof TokenExpiredError) return next(AppError.unauthorized('Access token expired'));
    if (err instanceof JsonWebTokenError) return next(AppError.unauthorized('Invalid access token'));
    next(err);
  }
}
