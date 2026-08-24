-- Row-level security: second gate behind the service-layer WHERE tenant_id
-- enforcement in src/services/*.ts. Policies check a session-local setting,
-- app.tenant_id, which must be SET for the current transaction before a
-- tenant-scoped query runs — see withTenantContext() in src/db/index.ts.
--
-- NOTE: the app's DB role must NOT have BYPASSRLS (Supabase's default
-- non-superuser roles already satisfy this). If DATABASE_URL connects as a
-- superuser/owner role, RLS is silently skipped — verify role privileges
-- in the Supabase dashboard before relying on this as the sole gate.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE extractions FORCE ROW LEVEL SECURITY;
ALTER TABLE document_audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE extractions ADD COLUMN vendor_tax_id varchar(100);

-- tenants: a row is visible only to members of that tenant
CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid);

-- users: scoped directly by tenant_id column
CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- documents: scoped directly by tenant_id column
CREATE POLICY tenant_isolation_documents ON documents
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- extractions: scoped via parent document's tenant_id (no tenant_id column here)
CREATE POLICY tenant_isolation_extractions ON extractions
  USING (
    document_id IN (
      SELECT id FROM documents WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );

-- document_audit_log: scoped via parent document's tenant_id
CREATE POLICY tenant_isolation_document_audit_log ON document_audit_log
  USING (
    document_id IN (
      SELECT id FROM documents WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );

-- webhook_deliveries: scoped directly by tenant_id column
CREATE POLICY tenant_isolation_webhook_deliveries ON webhook_deliveries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
