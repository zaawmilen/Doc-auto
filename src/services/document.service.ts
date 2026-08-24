import { eq, and, desc, count } from 'drizzle-orm';
import { withTenantContext } from '../db/index.js';
import { documents, documentsExtraction, documentAuditLog } from '../db/schema.js';
import { uploadDocument, getPresignedUrl } from '../lib/storage.js';
import { ocrQueue } from '../queues/index.js';
import { ocrJobId } from '../queues/jobIds.js';
import { randomUUID } from 'node:crypto';
import { queueJobsEnqueuedTotal } from '../lib/metrics.js';
import { writeAuditLog } from './audit.service.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { z } from 'zod';
import type { editExtractionSchema } from '../validators/documents.js';

export async function uploadNewDocument(params: {
  tenantId: string;
  uploadedBy: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  correlationId?: string;
}) {
  // Insert the row first so we have a documentId to use as the storage path prefix —
  // multi-tenant isolation: every object lives under <tenantId>/<documentId>/...
  const [document] = await withTenantContext(params.tenantId, async (tx) => tx.insert(documents).values({
    tenantId: params.tenantId,
    uploadedBy: params.uploadedBy,
    storageKey: 'pending', // placeholder, updated right after storage upload succeeds
    fileName: params.fileName,
    mimeType: params.mimeType,
    status: 'uploaded',
  }).returning());

  if (!document) throw AppError.internal('Failed to create document record');

  try {
    const { storageKey } = await uploadDocument({
      tenantId: params.tenantId,
      documentId: document.id,
      fileName: params.fileName,
      buffer: params.buffer,
      contentType: params.mimeType,
    });

    await withTenantContext(params.tenantId, async (tx) => {
      await tx.update(documents).set({ storageKey, updatedAt: new Date() }).where(eq(documents.id, document.id));
    });

    await writeAuditLog({
      tenantId: params.tenantId,
      documentId: document.id,
      actorId: params.uploadedBy,
      event: 'uploaded',
      newStatus: 'uploaded',
      payload: { fileName: params.fileName, mimeType: params.mimeType },
    });

    // Upload response is instant — OCR runs async on the worker.
    await ocrQueue.add(
      'ocr',
      {
        documentId: document.id,
        tenantId: params.tenantId,
        processingRunId: 'initial',
        _correlationId: params.correlationId,
      },
      { jobId: ocrJobId(document.id) },
    );
    queueJobsEnqueuedTotal.inc({ queue: 'ocr-jobs' });

    logger.info({ documentId: document.id, tenantId: params.tenantId }, '[Upload] Document stored, OCR job enqueued');

    return { ...document, storageKey };
  } catch (err) {
    await withTenantContext(params.tenantId, async (tx) => {
      await tx.update(documents).set({ status: 'failed', updatedAt: new Date() }).where(eq(documents.id, document.id));
    });
    logger.error({ documentId: document.id, err }, '[Upload] Storage upload failed');
    throw AppError.internal('Failed to store uploaded document');
  }
}

export async function listDocuments(params: {
  tenantId: string;
  status?: string;
  page: number;
  pageSize: number;
}) {
  const conditions = [eq(documents.tenantId, params.tenantId)];
  if (params.status) {
    conditions.push(eq(documents.status, params.status as typeof documents.$inferSelect.status));
  }

  const { rows, totalRows } = await withTenantContext(params.tenantId, async (tx) => {
    const [rows, totalRows] = await Promise.all([
      tx.select().from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.createdAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      tx.select({ total: count() }).from(documents).where(and(...conditions)),
    ]);
    return { rows, totalRows };
  });

  return { documents: rows, page: params.page, pageSize: params.pageSize, total: totalRows[0]?.total ?? 0 };
}

export async function getDocumentWithAudit(params: { tenantId: string; documentId: string }) {
  const document = await withTenantContext(params.tenantId, async (tx) => tx.query.documents.findFirst({
    where: and(eq(documents.id, params.documentId), eq(documents.tenantId, params.tenantId)),
    with: { extraction: true },
  }));
  if (!document) throw AppError.notFound('Document');

  const auditLog = await withTenantContext(params.tenantId, async (tx) => tx.select().from(documentAuditLog)
    .where(eq(documentAuditLog.documentId, params.documentId))
    .orderBy(desc(documentAuditLog.createdAt)));

  return { ...document, auditLog };
}

export async function getDocumentFileUrl(params: { tenantId: string; documentId: string }) {
  const document = await withTenantContext(params.tenantId, async (tx) => tx.query.documents.findFirst({
    where: and(eq(documents.id, params.documentId), eq(documents.tenantId, params.tenantId)),
    columns: { storageKey: true },
  }));
  if (!document) throw AppError.notFound('Document');
  const url = await getPresignedUrl(document.storageKey, 60);
  return { url, expiresIn: 60 };
}

type ExtractionEdit = z.infer<typeof editExtractionSchema>['body'];

export async function approveDocument(params: {
  tenantId: string;
  documentId: string;
  actorId: string;
}) {
  return withTenantContext(params.tenantId, async (tx) => {
    const document = await tx.query.documents.findFirst({
      where: and(eq(documents.id, params.documentId), eq(documents.tenantId, params.tenantId)),
      columns: { id: true, status: true },
    });
    if (!document) throw AppError.notFound('Document');
    if (document.status !== 'pending_review') {
      throw AppError.conflict('Only documents pending review can be approved', 'INVALID_DOCUMENT_STATUS');
    }

    const [updated] = await tx.update(documents)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(and(eq(documents.id, params.documentId), eq(documents.status, 'pending_review')))
      .returning();
    if (!updated) throw AppError.conflict('Document status changed before approval', 'INVALID_DOCUMENT_STATUS');

    await tx.insert(documentAuditLog).values({
      documentId: params.documentId,
      actorId: params.actorId,
      event: 'approved',
      prevStatus: 'pending_review',
      newStatus: 'approved',
    });
    return updated;
  });
}

export async function rejectDocument(params: {
  tenantId: string;
  documentId: string;
  actorId: string;
  reason: string;
}) {
  return withTenantContext(params.tenantId, async (tx) => {
    const document = await tx.query.documents.findFirst({
      where: and(eq(documents.id, params.documentId), eq(documents.tenantId, params.tenantId)),
      columns: { id: true, status: true },
    });
    if (!document) throw AppError.notFound('Document');
    if (document.status !== 'pending_review') {
      throw AppError.conflict('Only documents pending review can be rejected', 'INVALID_DOCUMENT_STATUS');
    }

    const [updated] = await tx.update(documents)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(eq(documents.id, params.documentId), eq(documents.status, 'pending_review')))
      .returning();
    if (!updated) throw AppError.conflict('Document status changed before rejection', 'INVALID_DOCUMENT_STATUS');

    await tx.insert(documentAuditLog).values({
      documentId: params.documentId,
      actorId: params.actorId,
      event: 'rejected',
      prevStatus: 'pending_review',
      newStatus: 'rejected',
      payload: { reason: params.reason },
    });
    return updated;
  });
}

export async function editDocumentExtraction(params: {
  tenantId: string;
  documentId: string;
  actorId: string;
  changes: ExtractionEdit;
}) {
  return withTenantContext(params.tenantId, async (tx) => {
    const document = await tx.query.documents.findFirst({
      where: and(eq(documents.id, params.documentId), eq(documents.tenantId, params.tenantId)),
      columns: { id: true, status: true },
    });
    if (!document) throw AppError.notFound('Document');
    if (document.status !== 'pending_review') {
      throw AppError.conflict('Only documents pending review can be edited', 'INVALID_DOCUMENT_STATUS');
    }

    const extraction = await tx.query.documentsExtraction.findFirst({
      where: eq(documentsExtraction.documentId, params.documentId),
    });
    if (!extraction) throw AppError.conflict('Document has no extraction to edit', 'EXTRACTION_NOT_FOUND');

    const changes = params.changes;
    const updates: Partial<typeof documentsExtraction.$inferInsert> = {};
    if (changes.vendorName !== undefined) updates.vendorName = changes.vendorName;
    if (changes.vendorAddress !== undefined) updates.vendorAddress = changes.vendorAddress;
    if (changes.vendorTaxId !== undefined) updates.vendorTaxId = changes.vendorTaxId;
    if (changes.invoiceNumber !== undefined) updates.invoiceNumber = changes.invoiceNumber;
    if (changes.invoiceDate !== undefined) updates.invoiceDate = changes.invoiceDate;
    if (changes.dueDate !== undefined) updates.dueDate = changes.dueDate;
    if (changes.subtotal !== undefined) updates.subtotal = changes.subtotal?.toFixed(2) ?? null;
    if (changes.tax !== undefined) updates.tax = changes.tax?.toFixed(2) ?? null;
    if (changes.total !== undefined) updates.total = changes.total?.toFixed(2) ?? null;
    if (changes.lineItems !== undefined) updates.lineItems = changes.lineItems;
    if (changes.confidenceScores !== undefined) updates.confidenceScores = changes.confidenceScores;

    const [updated] = await tx.update(documentsExtraction)
      .set(updates)
      .where(eq(documentsExtraction.documentId, params.documentId))
      .returning();
    if (!updated) throw AppError.conflict('Extraction changed before edit', 'EXTRACTION_EDIT_CONFLICT');

    await tx.insert(documentAuditLog).values({
      documentId: params.documentId,
      actorId: params.actorId,
      event: 'field_edited',
      prevStatus: document.status,
      newStatus: document.status,
      payload: { changes },
    });
    return updated;
  });
}

export async function reprocessDocument(params: {
  tenantId: string;
  documentId: string;
  actorId: string;
}) {
  const document = await withTenantContext(params.tenantId, async (tx) => {
    const current = await tx.query.documents.findFirst({
      where: and(eq(documents.id, params.documentId), eq(documents.tenantId, params.tenantId)),
      columns: { id: true, storageKey: true, status: true },
    });
    if (!current) throw AppError.notFound('Document');
    if (!['failed', 'rejected'].includes(current.status)) {
      throw AppError.conflict('Only failed or rejected documents can be reprocessed', 'INVALID_DOCUMENT_STATUS');
    }

    await tx.delete(documentsExtraction).where(eq(documentsExtraction.documentId, params.documentId));
    const [updated] = await tx.update(documents)
      .set({ status: 'uploaded', rawText: null, docType: null, updatedAt: new Date() })
      .where(and(eq(documents.id, params.documentId), eq(documents.status, current.status)))
      .returning();
    if (!updated) throw AppError.conflict('Document changed before reprocessing', 'INVALID_DOCUMENT_STATUS');

    await tx.insert(documentAuditLog).values({
      documentId: params.documentId,
      actorId: params.actorId,
      event: 'reprocessed',
      prevStatus: current.status,
      newStatus: 'uploaded',
    });
    return updated;
  });

  const processingRunId = randomUUID();
  await ocrQueue.add(
    'ocr',
    { documentId: params.documentId, tenantId: params.tenantId, processingRunId },
    { jobId: ocrJobId(params.documentId, processingRunId) },
  );
  queueJobsEnqueuedTotal.inc({ queue: 'ocr-jobs' });
  return document;
}
