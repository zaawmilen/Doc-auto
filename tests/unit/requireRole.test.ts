import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireRole } from '../../src/middleware/requireRole.js';
import { AppError } from '../../src/lib/errors.js';
import type { AccessTokenPayload } from '../../src/lib/jwt.js';

function mockReq(user?: AccessTokenPayload): Request {
  return { user } as unknown as Request;
}

function mockRes(): Response {
  return {} as Response;
}

const basePayload: AccessTokenPayload = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  email: 'x@example.com',
  role: 'viewer',
  jti: 'jti-1',
};

describe('requireRole', () => {
  it('rejects when req.user is missing (requireAuth was skipped or failed silently)', () => {
    const next = vi.fn() as unknown as NextFunction;

    requireRole('admin')(mockReq(undefined), mockRes(), next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(401);
  });

  it('rejects a user whose role is not in the allowed list', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = mockReq({ ...basePayload, role: 'viewer' });

    requireRole('admin', 'reviewer')(req, mockRes(), next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/admin or reviewer/i);
  });

  it('allows a user whose role is in the allowed list', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = mockReq({ ...basePayload, role: 'admin' });

    requireRole('admin', 'reviewer')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(); // no error
  });

  it('allows any of several permitted roles, not just the first one', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = mockReq({ ...basePayload, role: 'reviewer' });

    requireRole('admin', 'reviewer')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a role string that only superficially resembles an allowed role', () => {
    // Guards against a naive substring/prefix check instead of an exact match.
    const next = vi.fn() as unknown as NextFunction;
    const req = mockReq({ ...basePayload, role: 'admin-impersonator' });

    requireRole('admin')(req, mockRes(), next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });
});
