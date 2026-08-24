import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const integrityMigration = readFileSync(
  new URL('../../src/db/migrations/0005_rainy_mastermind.sql', import.meta.url),
  'utf8',
);

describe('integrity migration contract', () => {
  it('does not recreate or drop existing tables', () => {
    expect(integrityMigration).not.toMatch(/DROP\s+TABLE|CREATE\s+TABLE/i);
  });

  it('creates the required tenant and one-to-one integrity indexes', () => {
    expect(integrityMigration).toContain('documents_extraction_document_id_unique');
    expect(integrityMigration).toContain('users_email_unique');
    expect(integrityMigration).toContain('documents_tenant_status_created_at_idx');
    expect(integrityMigration).toContain('document_audit_log_document_created_at_idx');
  });
});