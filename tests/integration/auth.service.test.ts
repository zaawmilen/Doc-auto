import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// This suite needs a real database and Redis (refresh tokens live in Redis,
// see src/lib/tokens.ts) — skip cleanly if the test DB isn't configured,
// matching the pattern in tests/integration/tenant-isolation.test.ts.
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration('auth service (integration)', () => {
  // Imported inside the suite so env vars set by the test runner are in
  // place before src/config/env.ts validates process.env at import time.
  let AuthService: typeof import('../../src/services/auth.service.js');
  let pool: typeof import('../../src/db/index.js').pool;
  let redis: typeof import('../../src/lib/redis.js').redis;

  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `auth-test-${suffix}`;
  const email = `auth-test-${suffix}@example.test`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    AuthService = await import('../../src/services/auth.service.js');
    ({ pool } = await import('../../src/db/index.js'));
    ({ redis } = await import('../../src/lib/redis.js'));
    if (redis.status !== 'ready') await redis.connect();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    await pool.query('DELETE FROM tenants WHERE slug = $1', [tenantSlug]);
    const { closeRedis } = await import('../../src/lib/redis.js');
    await closeRedis();
  });

  it('registers a new tenant + admin user', async () => {
    const result = await AuthService.register({
      tenantName: 'Auth Test Co',
      tenantSlug,
      email,
      password,
    });

    expect(result.tenant.slug).toBe(tenantSlug);
    expect(result.user.email).toBe(email);
    expect(result.user.role).toBe('admin');
  });

  it('rejects registration with an already-taken tenant slug', async () => {
    await expect(
      AuthService.register({
        tenantName: 'Someone Else',
        tenantSlug, // same slug as above
        email: `other-${suffix}@example.test`,
        password,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'TENANT_SLUG_TAKEN' });
  });

  it('rejects registration with an already-taken email', async () => {
    await expect(
      AuthService.register({
        tenantName: 'Another Co',
        tenantSlug: `${tenantSlug}-2`,
        email, // same email as above
        password,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' });
    // clean up the extra tenant this attempt may or may not have created
    await pool.query('DELETE FROM tenants WHERE slug = $1', [`${tenantSlug}-2`]);
  });

  it('logs in with correct credentials and returns tokens', async () => {
    const result = await AuthService.login({ email, password });

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.user.email).toBe(email);
  });

  it('rejects login with the wrong password', async () => {
    await expect(
      AuthService.login({ email, password: 'wrong-password' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects login for a nonexistent email without revealing that distinction', async () => {
    // Same error shape as a wrong password — this is what the dummy-hash
    // compare in auth.service.ts is there to protect (no timing/response
    // difference between "no such user" and "wrong password").
    await expect(
      AuthService.login({ email: `nobody-${suffix}@example.test`, password }),
    ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/invalid email or password/i) });
  });

  it('rotates a refresh token: old token stops working, new one works', async () => {
    const loginResult = await AuthService.login({ email, password });
    const oldRefreshToken = loginResult.refreshToken;

    const refreshed = await AuthService.refresh(oldRefreshToken);
    expect(refreshed.accessToken).toEqual(expect.any(String));
    expect(refreshed.refreshToken).not.toBe(oldRefreshToken);

    // old token must now be dead (rotation, not just issuing a second valid one)
    await expect(AuthService.refresh(oldRefreshToken)).rejects.toMatchObject({ statusCode: 401 });

    // the new token must work
    const refreshedAgain = await AuthService.refresh(refreshed.refreshToken);
    expect(refreshedAgain.accessToken).toEqual(expect.any(String));
  });

  it('rejects an unknown / already-used refresh token', async () => {
    await expect(AuthService.refresh(randomUUID())).rejects.toMatchObject({ statusCode: 401 });
  });

  it('logout revokes the refresh token so it can no longer be used', async () => {
    const loginResult = await AuthService.login({ email, password });

    await AuthService.logout(loginResult.refreshToken);

    await expect(AuthService.refresh(loginResult.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });
});
