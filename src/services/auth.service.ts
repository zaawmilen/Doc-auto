import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users } from '../db/schema.js';
import { hashPassword, comparePassword } from '../lib/password.js';
import { signAccessToken } from '../lib/jwt.js';
import { storeRefreshToken, rotateRefreshToken, revokeRefreshToken } from '../lib/tokens.js';
import { AppError } from '../lib/errors.js';
import type { RegisterInput, LoginInput } from '../validators/auth.js';

const DUMMY_HASH = '$2b$12$K8GpYyC7VpQLu5VyVnCHCuIqG5GjBd5KVHcJdX3o5tElYVqfV5g8e';

export async function register(input: RegisterInput) {
  const existingTenant = await db.query.tenants.findFirst({
    where: eq(tenants.slug, input.tenantSlug),
    columns: { id: true },
  });
  if (existingTenant) throw AppError.conflict('A tenant with this slug already exists', 'TENANT_SLUG_TAKEN');

  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, input.email),
    columns: { id: true },
  });
  if (existingUser) throw AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.password);

  // Tenant + first (admin) user created together — no tenant exists without an owner.
  const [tenant] = await db.insert(tenants).values({
    name: input.tenantName,
    slug: input.tenantSlug,
  }).returning({ id: tenants.id, name: tenants.name, slug: tenants.slug });

  if (!tenant) throw AppError.internal('Tenant creation failed');

  const [user] = await db.insert(users).values({
    tenantId: tenant.id,
    email: input.email,
    passwordHash,
    role: 'admin',
  }).returning({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt });

  return { tenant, user };
}

export async function login(input: LoginInput) {
  const user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  const passwordMatch = await comparePassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordMatch) throw AppError.unauthorized('Invalid email or password');

  const accessToken = signAccessToken({ sub: user.id, tenantId: user.tenantId, email: user.email, role: user.role });
  const refreshToken = await storeRefreshToken({
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
  });
  return { accessToken, refreshToken, user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId } };
}

export async function refresh(oldTokenId: string) {
  const result = await rotateRefreshToken(oldTokenId);
  if (!result) throw AppError.unauthorized('Invalid or expired refresh token');
  const { newTokenId, data } = result;
  const accessToken = signAccessToken({ sub: data.userId, tenantId: data.tenantId, email: data.email, role: data.role });
  return { accessToken, refreshToken: newTokenId };
}

export async function logout(tokenId: string): Promise<void> {
  await revokeRefreshToken(tokenId);
}
