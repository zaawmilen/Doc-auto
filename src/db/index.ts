import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema.js';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle client error in Postgres pool');
});

export const db = drizzle(pool, { schema });

export async function checkDatabaseConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
  logger.info('Postgres pool closed');
}

/**
 * Runs `fn` inside a transaction with app.tenant_id set for the session,
 * which the RLS policies in 0001_enable_row_level_security.sql check.
 *
 * Document services, audit writes, and workers use this helper for tenant-scoped
 * operations. Authentication remains a bootstrap boundary: email-only login must
 * locate the tenant before a tenant context exists and needs a dedicated login
 * resolver or tenant identifier before users can be forced through RLS.
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // SET LOCAL does not accept bind parameters (Postgres only allows literals
    // after SET) — use set_config(), a regular function, which does.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export { pool };
