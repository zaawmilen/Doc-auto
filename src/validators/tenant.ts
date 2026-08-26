import { z } from 'zod';

export const updateTenantSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(255).optional(),
    // Stored as numeric(3,2) — 0.00 to 1.00. Sent/received as a plain
    // number for API ergonomics; drizzle handles the numeric<->string
    // conversion at the query layer.
    extractionThreshold: z.number().min(0).max(1).optional(),
    // Explicit null clears the webhook (disables delivery); undefined
    // leaves it unchanged; a string must be a valid absolute URL.
    webhookUrl: z.string().trim().url().nullable().optional(),
  }).refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field must be provided',
  }),
});
