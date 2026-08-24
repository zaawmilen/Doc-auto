import { z } from 'zod';
import { confidenceScoresSchema, lineItemSchema } from './extraction.js';

export const listDocumentsSchema = z.object({
  query: z.object({
    status: z.enum([
      'uploaded', 'ocr_processing', 'extracting', 'extracted',
      'pending_review', 'approved', 'rejected', 'failed',
    ]).optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const documentIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const rejectDocumentSchema = z.object({
  body: z.object({
    reason: z.string().trim().min(1).max(1000),
  }),
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const editExtractionSchema = z.object({
  body: z.object({
    vendorName: z.string().trim().max(1000).nullable().optional(),
    vendorAddress: z.string().trim().max(2000).nullable().optional(),
    vendorTaxId: z.string().trim().max(100).nullable().optional(),
    invoiceNumber: z.string().trim().max(100).nullable().optional(),
    invoiceDate: z.string().date().nullable().optional(),
    dueDate: z.string().date().nullable().optional(),
    subtotal: z.number().finite().nonnegative().nullable().optional(),
    tax: z.number().finite().nonnegative().nullable().optional(),
    total: z.number().finite().nonnegative().nullable().optional(),
    lineItems: z.array(lineItemSchema).max(1000).optional(),
    confidenceScores: confidenceScoresSchema.optional(),
  }).refine((body) => Object.keys(body).length > 0, {
    message: 'At least one extraction field must be provided',
  }),
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const reprocessDocumentSchema = documentIdParamSchema;

export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'];
