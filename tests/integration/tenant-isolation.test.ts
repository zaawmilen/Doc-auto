import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('PostgreSQL tenant isolation', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenantIds = [randomUUID(), randomUUID()];
  const userIds = [randomUUID(), randomUUID()];
  const documentIds = [randomUUID(), randomUUID()];

  async function withTenant(client: PoolClient, tenantId: string, callback: () => Promise<void>) {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    try {
      await callback();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  beforeAll(async () => {
    const client = await pool.connect();
    try {
      for (const [index, tenantId] of tenantIds.entries()) {
        await withTenant(client, tenantId, async () => {
          await client.query(
            'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
            [tenantId, `Isolation Tenant ${index}`, `isolation-${tenantId}`],
          );
          await client.query(
            'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
            [userIds[index], tenantId, `${tenantId}@example.test`, 'test-hash', 'viewer'],
          );
          await client.query(
            'INSERT INTO documents (id, tenant_id, uploaded_by, storage_key, file_name, mime_type) VALUES ($1, $2, $3, $4, $5, $6)',
            [documentIds[index], tenantId, userIds[index], `${tenantId}/document.pdf`, 'document.pdf', 'application/pdf'],
          );
        });
      }
    } finally {
      client.release();
    }
  });

  it('only exposes rows belonging to the active tenant context', async () => {
    const client = await pool.connect();
    try {
      await withTenant(client, tenantIds[0], async () => {
        const documents = await client.query('SELECT id FROM documents ORDER BY id');
        const otherTenant = await client.query('SELECT id FROM documents WHERE id = $1', [documentIds[1]]);

        expect(documents.rows).toHaveLength(1);
        expect(documents.rows[0].id).toBe(documentIds[0]);
        expect(otherTenant.rows).toHaveLength(0);
      });
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      for (const tenantId of tenantIds) {
        await withTenant(client, tenantId, async () => {
          await client.query('DELETE FROM documents WHERE tenant_id = $1', [tenantId]);
          await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
          await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
        });
      }
    } finally {
      client.release();
      await pool.end();
    }
  });
});