import { createHmac } from 'node:crypto';

export interface WebhookPayload {
  event: 'document.approved' | 'document.rejected';
  documentId: string;
  tenantId: string;
  status: 'approved' | 'rejected';
  docType: string | null;
  timestamp: string;
  reason?: string;
  extraction?: {
    vendorName: string | null;
    invoiceNumber: string | null;
    total: string | null;
  };
}

/**
 * Signs the exact string that will be sent as the request body — never a
 * re-serialized copy of the object — so the receiver's HMAC check is over
 * the identical bytes it actually receives, with no risk of a key-ordering
 * mismatch between signing and sending.
 */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
