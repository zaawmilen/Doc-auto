import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withTenantContext } from '../db/index.js';
import { tenants, users } from '../db/schema.js';
import { hashPassword, comparePassword } from '../lib/password.js';
import { signAccessToken } from '../lib/jwt.js';
import { storeRefreshToken, rotateRefreshToken, revokeRefreshToken } from '../lib/tokens.js';
import { AppError } from '../lib/errors.js';
import type { RegisterInput, LoginInput } from '../validators/auth.js';

const DUMMY_HASH = '$2b$12$K8GpYyC7VpQLu5VyVnCHCuIqG5GjBd5KVHcJdX3o5tElYVqfV5g8e';

// Postgres unique_violation, surfaced by Drizzle as DrizzleQueryError with the
// original pg DatabaseError on .cause (code + constraint name preserved there).
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const cause = (err as { cause?: { code?: string; constraint?: string } })?.cause;
  return cause?.code === '23505' && cause?.constraint === constraint;
}

export async function register(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);

  // Registration happens before any tenant context exists, so the RLS policies
  // in 0001_enable_row_level_security.sql — which gate both visibility AND
  // inserts on the current app.tenant_id — would silently block a "does this
  // slug/email already exist" pre-check (it would never see existing rows) as
  // well as the insert itself (a fresh id can't match a context that was never
  // set). Rather than a broken, racy check-then-insert, we pre-generate the new
  // tenant's id, use it as this transaction's tenant context (satisfying the
  // RLS insert checks), and let the database's own unique constraints
  // (tenants.slug, users.email) be the source of truth, translating a
  // unique-violation into the right 409. This also makes tenant+user creation
  // atomic — the previous version ran two independent top-level inserts, so a
  // failed user insert could leave an orphaned tenant with no admin user.
  const tenantId = randomUUID();

  try {
    return await withTenantContext(tenantId, async (tx) => {
      const [tenant] = await tx.insert(tenants).values({
        id: tenantId,
        name: input.tenantName,
        slug: input.tenantSlug,
      }).returning({ id: tenants.id, name: tenants.name, slug: tenants.slug });

      if (!tenant) throw AppError.internal('Tenant creation failed');

      let user;
      try {
        [user] = await tx.insert(users).values({
          tenantId: tenant.id,
          email: input.email,
          passwordHash,
          role: 'admin',
        }).returning({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt });
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_unique')) {
          throw AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
        }
        throw err;
      }

      return { tenant, user };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'tenants_slug_unique')) {
      throw AppError.conflict('A tenant with this slug already exists', 'TENANT_SLUG_TAKEN');
    }
    throw err;
  }
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
