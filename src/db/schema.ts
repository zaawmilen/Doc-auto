import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ── Enums ─────────────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum('user_role', ['admin', 'reviewer', 'viewer']);

export const documentStatusEnum = pgEnum('document_status', [
  'uploaded',
  'ocr_processing',
  'extracting',
  'extracted',
  'pending_review',
  'approved',
  'rejected',
  'failed',
]);

export const docTypeEnum = pgEnum('doc_type', ['invoice', 'receipt', 'purchase_order', 'unknown']);

export const auditEventEnum = pgEnum('audit_event', [
  'uploaded',
  'ocr_complete',
  'extracted',
  'auto_approved',
  'sent_to_review',
  'approved',
  'rejected',
  'field_edited',
  'webhook_sent',
  'webhook_failed',
  'reprocessed',
]);

export const webhookStatusEnum = pgEnum('webhook_status', ['pending', 'success', 'failed', 'dead_letter']);

// ── tenants ───────────────────────────────────────────────────────────────────
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  extractionThreshold: numeric('extraction_threshold', { precision: 3, scale: 2 }).notNull().default('0.85'),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── users ─────────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('viewer'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
  index('users_tenant_id_idx').on(table.tenantId),
]);

// ── documents ─────────────────────────────────────────────────────────────────
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  storageKey: text('storage_key').notNull(),
  fileName: varchar('file_name', { length: 500 }).notNull(),
  mimeType: varchar('mime_type', { length: 100 }).notNull(),
  status: documentStatusEnum('status').notNull().default('uploaded'),
  docType: docTypeEnum('doc_type'),
  rawText: text('raw_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('documents_tenant_created_at_idx').on(table.tenantId, table.createdAt),
  index('documents_tenant_status_created_at_idx').on(table.tenantId, table.status, table.createdAt),
]);

// ── documentsExtraction ───────────────────────────────────────────────────────────────
export const documentsExtraction = pgTable('documents_extraction', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id),
  vendorName: text('vendor_name'),
  vendorAddress: text('vendor_address'),
  vendorTaxId: varchar('vendor_tax_id', { length: 100 }),
  invoiceNumber: varchar('invoice_number', { length: 100 }),
  invoiceDate: date('invoice_date'),
  dueDate: date('due_date'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }),
  tax: numeric('tax', { precision: 12, scale: 2 }),
  total: numeric('total', { precision: 12, scale: 2 }),
  confidenceScores: jsonb('confidence_scores').$type<Record<string, number>>(),
  lineItems: jsonb('line_items').$type<Array<{ description: string; quantity: number; unitPrice: number; amount: number }>>(),
  llmModel: varchar('llm_model', { length: 100 }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('documents_extraction_document_id_unique').on(table.documentId),
]);

// ── document_audit_log (append-only) ────────────────────────────────────────
export const documentAuditLog = pgTable('document_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id),
  actorId: uuid('actor_id').references(() => users.id),
  event: auditEventEnum('event').notNull(),
  prevStatus: text('prev_status'),
  newStatus: text('new_status'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('document_audit_log_document_created_at_idx').on(table.documentId, table.createdAt),
]);

// ── webhook_deliveries ───────────────────────────────────────────────────────
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  status: webhookStatusEnum('status').notNull().default('pending'),
  attempt: integer('attempt').notNull().default(1),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, (table) => [
  index('webhook_deliveries_status_idx').on(table.status),
  index('webhook_deliveries_document_id_idx').on(table.documentId),
]);

// ── relations ────────────────────────────────────────────────────────────────
export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  documents: many(documents),
}));

export const usersRelations = relations(users, ({ one }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  tenant: one(tenants, { fields: [documents.tenantId], references: [tenants.id] }),
  uploader: one(users, { fields: [documents.uploadedBy], references: [users.id] }),
  extraction: one(documentsExtraction, { fields: [documents.id], references: [documentsExtraction.documentId] }),
  auditLog: many(documentAuditLog),
  webhookDeliveries: many(webhookDeliveries),
}));

export const documentsExtractionRelations = relations(documentsExtraction, ({ one }) => ({
  document: one(documents, { fields: [documentsExtraction.documentId], references: [documents.id] }),
}));

export const documentAuditLogRelations = relations(documentAuditLog, ({ one }) => ({
  document: one(documents, { fields: [documentAuditLog.documentId], references: [documents.id] }),
  actor: one(users, { fields: [documentAuditLog.actorId], references: [users.id] }),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  document: one(documents, { fields: [webhookDeliveries.documentId], references: [documents.id] }),
  tenant: one(tenants, { fields: [webhookDeliveries.tenantId], references: [tenants.id] }),
}));
