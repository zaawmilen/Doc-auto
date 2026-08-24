import { describe, expect, it } from 'vitest';
import { evaluateExtraction } from '../../src/lib/decision-engine.js';
import type { InvoiceExtraction } from '../../src/validators/extraction.js';

const extraction: InvoiceExtraction = {
  vendor: { name: 'Acme Supplies', address: '123 Main St', taxId: '47-1234567' },
  invoice: { number: 'INV-100', date: '2026-08-24', dueDate: '2026-09-24' },
  totals: { subtotal: 100, tax: 8, total: 108 },
  lineItems: [{ description: 'Service', quantity: 1, unitPrice: 100, amount: 100 }],
  confidence: {
    'vendor.name': 0.95,
    'vendor.address': 0.95,
    'vendor.taxId': 0.95,
    'invoice.number': 0.95,
    'invoice.date': 0.95,
    'invoice.dueDate': 0.95,
    'totals.subtotal': 0.95,
    'totals.tax': 0.95,
    'totals.total': 0.95,
    lineItems: 0.95,
  },
};

describe('evaluateExtraction', () => {
  it('auto-approves valid extraction above the tenant threshold', () => {
    const result = evaluateExtraction(extraction, 0.85);

    expect(result.decision).toBe('auto_approve');
    expect(result.mathValid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('routes extraction to review when confidence is below threshold', () => {
    const result = evaluateExtraction({
      ...extraction,
      confidence: { ...extraction.confidence, 'vendor.taxId': 0.72 },
    }, 0.85);

    expect(result.decision).toBe('route_to_review');
    expect(result.reasons[0]).toContain('vendor.taxId confidence');
  });

  it('routes extraction to review when line items do not match subtotal', () => {
    const result = evaluateExtraction({
      ...extraction,
      totals: { ...extraction.totals, subtotal: 101 },
    }, 0.85);

    expect(result.decision).toBe('route_to_review');
    expect(result.mathValid).toBe(false);
    expect(result.reasons[0]).toContain('does not match subtotal');
  });
});