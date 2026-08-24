import { z } from 'zod';

export const docTypeSchema = z.enum(['invoice', 'receipt', 'purchase_order', 'unknown']);

export const classificationResultSchema = z.object({
  docType: docTypeSchema,
  confidence: z.number().min(0).max(1),
});
export type ClassificationResult = z.infer<typeof classificationResultSchema>;

export const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  amount: z.number(),
});

// Confidence scores are separate tool parameters from the extracted values themselves —
// per the plan's prompt design principle: prevents the model conflating uncertainty
// with the value. Keys use dot-notation matching the plan's Extraction Model tab
// (e.g. "vendor.name", "totals.subtotal").
export const confidenceScoresSchema = z.object({
  'vendor.name': z.number().min(0).max(1),
  'vendor.address': z.number().min(0).max(1),
  'vendor.taxId': z.number().min(0).max(1),
  'invoice.number': z.number().min(0).max(1),
  'invoice.date': z.number().min(0).max(1),
  'invoice.dueDate': z.number().min(0).max(1),
  'totals.subtotal': z.number().min(0).max(1),
  'totals.tax': z.number().min(0).max(1),
  'totals.total': z.number().min(0).max(1),
  lineItems: z.number().min(0).max(1),
});
export type ConfidenceScores = z.infer<typeof confidenceScoresSchema>;

export const invoiceExtractionSchema = z.object({
  vendor: z.object({
    name: z.string().nullable(),
    address: z.string().nullable(),
    taxId: z.string().nullable(),
  }),
  invoice: z.object({
    number: z.string().nullable(),
    date: z.string().nullable(), // ISO date string
    dueDate: z.string().nullable(),
  }),
  totals: z.object({
    subtotal: z.number(),
    tax: z.number(),
    total: z.number(),
  }),
  lineItems: z.array(lineItemSchema),
  confidence: confidenceScoresSchema,
});
export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;
