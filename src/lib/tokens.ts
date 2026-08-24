import { v4 as uuidv4 } from 'uuid';
import { redis } from './redis.js';

const PREFIX = 'refresh_token:';
const TTL_SECONDS = 7 * 24 * 60 * 60;

export interface RefreshTokenData {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

export async function storeRefreshToken(data: RefreshTokenData): Promise<string> {
  const tokenId = uuidv4();
  await redis.setex(`${PREFIX}${tokenId}`, TTL_SECONDS, JSON.stringify(data));
  return tokenId;
}

export async function getRefreshToken(tokenId: string): Promise<RefreshTokenData | null> {
  const raw = await redis.get(`${PREFIX}${tokenId}`);
  if (!raw) return null;
  return JSON.parse(raw) as RefreshTokenData;
}

export async function revokeRefreshToken(tokenId: string): Promise<void> {
  await redis.del(`${PREFIX}${tokenId}`);
}

export async function rotateRefreshToken(
  oldTokenId: string,
): Promise<{ newTokenId: string; data: RefreshTokenData } | null> {
  const existing = await getRefreshToken(oldTokenId);
  if (!existing) return null;

  const newTokenId = uuidv4();
  const pipeline = redis.pipeline();
  pipeline.del(`${PREFIX}${oldTokenId}`);
  pipeline.setex(`${PREFIX}${newTokenId}`, TTL_SECONDS, JSON.stringify(existing));
  await pipeline.exec();

  return { newTokenId, data: existing };
}
