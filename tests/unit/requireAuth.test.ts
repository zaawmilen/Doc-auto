import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../src/middleware/requireAuth.js';
import { signAccessToken } from '../../src/lib/jwt.js';
import { AppError } from '../../src/lib/errors.js';

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function mockRes(): Response {
  return {} as Response;
}

describe('requireAuth', () => {
  it('rejects a request with no Authorization header', () => {
    const req = mockReq();
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(401);
  });

  it('rejects a header that is not a Bearer token', () => {
    const req = mockReq({ authorization: 'Basic dXNlcjpwYXNz' });
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.statusCode).toBe(401);
  });

  it('rejects a malformed / garbage token', () => {
    const req = mockReq({ authorization: 'Bearer not.a.valid.jwt' });
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/invalid access token/i);
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign(
      { sub: 'user-1', tenantId: 'tenant-1', email: 'x@example.com', role: 'admin', jti: 'x' },
      'not-the-real-secret',
    );
    const req = mockReq({ authorization: `Bearer ${forged}` });
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.statusCode).toBe(401);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign(
      { sub: 'user-1', tenantId: 'tenant-1', email: 'x@example.com', role: 'admin', jti: 'x' },
      process.env.JWT_ACCESS_SECRET!,
      { expiresIn: -10 }, // already expired
    );
    const req = mockReq({ authorization: `Bearer ${expired}` });
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/expired/i);
  });

  it('accepts a valid token and attaches req.user with the token claims', () => {
    const token = signAccessToken({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'x@example.com',
      role: 'reviewer',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(); // called with no error argument
    expect(req.user).toBeDefined();
    expect(req.user!.sub).toBe('user-1');
    expect(req.user!.tenantId).toBe('tenant-1');
    expect(req.user!.role).toBe('reviewer');
  });
});
