import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withTenantContext } from '../db/index.js';
import { tenants } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export async function getTenantConfig(tenantId: string) {
  const tenant = await withTenantContext(tenantId, async (tx) => tx.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
  }));
  if (!tenant) throw AppError.notFound('Tenant');

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    extractionThreshold: Number(tenant.extractionThreshold),
    webhookUrl: tenant.webhookUrl,
    // Never return the actual secret once it's been set — only whether one
    // exists. The value is shown exactly once, at generation time, from
    // rotateWebhookSecret below (same pattern Stripe/GitHub use for signing
    // secrets: shown once, then only re-derivable by rotating).
    webhookSecretConfigured: tenant.webhookSecret !== null,
  };
}

export async function updateTenantConfig(params: {
  tenantId: string;
  name?: string;
  extractionThreshold?: number;
  webhookUrl?: string | null;
}) {
  const updates: Partial<typeof tenants.$inferInsert> = {};
  if (params.name !== undefined) updates.name = params.name;
  if (params.extractionThreshold !== undefined) updates.extractionThreshold = params.extractionThreshold.toFixed(2);
  if (params.webhookUrl !== undefined) {
    updates.webhookUrl = params.webhookUrl;
    // Clearing the URL also clears the secret — an orphaned secret with no
    // URL to sign for is just dead sensitive data sitting in the table.
    if (params.webhookUrl === null) updates.webhookSecret = null;
  }

  const [updated] = await withTenantContext(params.tenantId, async (tx) => tx.update(tenants)
    .set(updates)
    .where(eq(tenants.id, params.tenantId))
    .returning());
  if (!updated) throw AppError.notFound('Tenant');

  return getTenantConfig(params.tenantId);
}

/**
 * Generates a new webhook signing secret server-side (never accepts one
 * from the client — letting an admin submit an arbitrary/weak secret
 * defeats the point of it being an unguessable HMAC key) and returns the
 * raw value exactly once. Requires a webhookUrl already configured, since a
 * secret with nothing to sign for isn't meaningful.
 */
export async function rotateWebhookSecret(tenantId: string): Promise<{ webhookSecret: string }> {
  const tenant = await withTenantContext(tenantId, async (tx) => tx.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { webhookUrl: true },
  }));
  if (!tenant) throw AppError.notFound('Tenant');
  if (!tenant.webhookUrl) {
    throw AppError.badRequest('Set a webhookUrl before generating a webhook secret', 'WEBHOOK_URL_NOT_CONFIGURED');
  }

  const secret = randomBytes(32).toString('hex');
  await withTenantContext(tenantId, async (tx) => tx.update(tenants)
    .set({ webhookSecret: secret })
    .where(eq(tenants.id, tenantId)));

  return { webhookSecret: secret };
}
