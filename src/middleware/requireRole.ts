import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors.js';

type Role = 'admin' | 'reviewer' | 'viewer';

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role as Role)) {
      return next(AppError.forbidden(`This action requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}
