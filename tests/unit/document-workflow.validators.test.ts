import { describe, expect, it } from 'vitest';
import { editExtractionSchema, rejectDocumentSchema } from '../../src/validators/documents.js';

const documentId = '00000000-0000-0000-0000-000000000001';

describe('document workflow validators', () => {
  it('requires a rejection reason', () => {
    expect(rejectDocumentSchema.safeParse({
      params: { id: documentId },
      body: { reason: '  ' },
    }).success).toBe(false);
  });

  it('accepts a bounded rejection reason', () => {
    expect(rejectDocumentSchema.safeParse({
      params: { id: documentId },
      body: { reason: 'Invoice total is incorrect' },
    }).success).toBe(true);
  });

  it('requires at least one extraction field to edit', () => {
    expect(editExtractionSchema.safeParse({
      params: { id: documentId },
      body: {},
    }).success).toBe(false);
  });

  it('accepts validated numeric extraction edits', () => {
    expect(editExtractionSchema.safeParse({
      params: { id: documentId },
      body: { subtotal: 120.5, tax: 9.64, total: 130.14 },
    }).success).toBe(true);
  });
});