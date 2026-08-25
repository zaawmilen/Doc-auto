-- Fixes a bug in the RLS policies from 0001_enable_row_level_security.sql:
-- current_setting('app.tenant_id', true) returns an EMPTY STRING once a
-- connection has ever had app.tenant_id set/reverted on it (e.g. after any
-- withTenantContext() transaction commits — SET LOCAL/set_config(..., true)
-- reverts to the empty-string placeholder, not to a true NULL, once the
-- custom GUC has been touched on that backend). Because Postgres's pooled
-- connections are reused across requests, this becomes the steady state for
-- essentially every connection shortly after the app starts handling any
-- tenant-scoped write — not a rare edge case.
--
-- Casting that empty string directly to ::uuid throws a hard Postgres error
-- (22P02, "invalid input syntax for type uuid") instead of the policy simply
-- evaluating to false. An `AND current_setting(...) <> ''` guard does NOT
-- reliably prevent this: Postgres's planner is free to evaluate boolean AND
-- sub-expressions in any order (no guaranteed short-circuiting), and was
-- observed pushing the ::uuid cast into an index condition on the tenant_id
-- column ahead of the guard, still throwing (verified empirically before
-- writing this fix).
--
-- The reliable fix is NULLIF(current_setting(...), '')::uuid — NULLIF maps
-- an empty string to a true NULL *before* the cast is ever applied, and
-- casting NULL::text to uuid always succeeds (returns NULL) regardless of
-- evaluation order, since there's never an invalid value to reject.
--
-- Note this only stops the crash (a missing/empty context now correctly
-- yields "no rows visible", same as a real RLS deny) — it does not change
-- what's visible for any context that *is* set, so tenant isolation itself
-- is unaffected. It also does not address the deeper issue that login-by-
-- email fundamentally cannot see any user row while no tenant context is
-- set (that needs a bootstrap-lookup design decision, tracked separately).

DROP POLICY IF EXISTS tenant_isolation_tenants ON tenants;
CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_users ON users;
CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_documents ON documents;
CREATE POLICY tenant_isolation_documents ON documents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_extractions ON documents_extraction;
CREATE POLICY tenant_isolation_extractions ON documents_extraction
  USING (
    document_id IN (
      SELECT id FROM documents WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS tenant_isolation_document_audit_log ON document_audit_log;
CREATE POLICY tenant_isolation_document_audit_log ON document_audit_log
  USING (
    document_id IN (
      SELECT id FROM documents WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS tenant_isolation_webhook_deliveries ON webhook_deliveries;
CREATE POLICY tenant_isolation_webhook_deliveries ON webhook_deliveries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
