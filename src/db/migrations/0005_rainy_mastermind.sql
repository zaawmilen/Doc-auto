CREATE UNIQUE INDEX IF NOT EXISTS "documents_extraction_document_id_unique"
  ON "documents_extraction" USING btree ("document_id");
CREATE INDEX IF NOT EXISTS "document_audit_log_document_created_at_idx"
  ON "document_audit_log" USING btree ("document_id", "created_at");
CREATE INDEX IF NOT EXISTS "documents_tenant_created_at_idx"
  ON "documents" USING btree ("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "documents_tenant_status_created_at_idx"
  ON "documents" USING btree ("tenant_id", "status", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique"
  ON "users" USING btree ("email");
CREATE INDEX IF NOT EXISTS "users_tenant_id_idx"
  ON "users" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_idx"
  ON "webhook_deliveries" USING btree ("status");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_document_id_idx"
  ON "webhook_deliveries" USING btree ("document_id");