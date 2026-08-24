import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  email: string;
  role: string;
  jti: string;
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'jti'>): string {
  const options: jwt.SignOptions = {};
  if (env.JWT_ACCESS_EXPIRES_IN) {
    options.expiresIn = env.JWT_ACCESS_EXPIRES_IN as Exclude<jwt.SignOptions['expiresIn'], undefined>;
  }

  return jwt.sign(
    { ...payload, jti: uuidv4() },
    env.JWT_ACCESS_SECRET as jwt.Secret,
    options,
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET as jwt.Secret) as AccessTokenPayload;
}
