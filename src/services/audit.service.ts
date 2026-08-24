import { withTenantContext } from '../db/index.js';
import { documentAuditLog } from '../db/schema.js';

type AuditEvent =
  | 'uploaded'
  | 'ocr_complete'
  | 'extracted'
  | 'auto_approved'
  | 'sent_to_review'
  | 'approved'
  | 'rejected'
  | 'field_edited'
  | 'webhook_sent'
  | 'webhook_failed'
  | 'reprocessed';

export async function writeAuditLog(params: {
  tenantId: string;
  documentId: string;
  actorId?: string | null;
  event: AuditEvent;
  prevStatus?: string | null;
  newStatus?: string | null;
  payload?: unknown;
}): Promise<void> {
  await withTenantContext(params.tenantId, async (tx) => {
    await tx.insert(documentAuditLog).values({
      documentId: params.documentId,
      actorId: params.actorId ?? null,
      event: params.event,
      prevStatus: params.prevStatus ?? null,
      newStatus: params.newStatus ?? null,
      payload: params.payload ?? null,
    });
  });
}
