import { env } from '../config/env.js';
import { logger } from './logger.js';
import { observeProviderCall, observeProviderTokens } from './metrics.js';
import {
  classificationResultSchema,
  invoiceExtractionSchema,
  type ClassificationResult,
  type InvoiceExtraction,
} from '../validators/extraction.js';

// Current Sonnet-tier model as of this writing — verify against
// https://docs.claude.com/en/docs/about-claude/models/overview before deploying,
// since Anthropic ships new dated/major model IDs periodically.
const MODEL = 'claude-sonnet-5';
const MAX_RETRIES = 3;

// Plan-specified estimate; re-check current rates in the Claude docs pricing page —
// per-token pricing can change between model generations.
const COST_PER_INPUT_TOKEN = 3 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000;

function hasApiKey(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

function logCost(kind: string, context: Record<string, unknown>, inputTokens: number, outputTokens: number) {
  const cost = inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
  observeProviderTokens(inputTokens, outputTokens);
  logger.info({ ...context, kind, model: MODEL, inputTokens, outputTokens, estimatedCostUsd: Number(cost.toFixed(6)) }, '[Anthropic] Call complete');
}

// ── Classification ────────────────────────────────────────────────────────────

const classifyTool = {
  name: 'classify_document',
  description: 'Classify a business document by type and report confidence in that classification.',
  input_schema: {
    type: 'object' as const,
    properties: {
      docType: { type: 'string', enum: ['invoice', 'receipt', 'purchase_order', 'unknown'] },
      confidence: { type: 'number', description: 'Confidence in this classification, 0 to 1' },
    },
    required: ['docType', 'confidence'],
  },
};

async function classifyReal(rawText: string, context: { documentId: string }): Promise<{ result: ClassificationResult; inputTokens: number; outputTokens: number }> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: 'You classify business documents from their OCR text. Be conservative — if the document does not clearly match invoice, receipt, or purchase_order, classify it as unknown rather than guessing.',
    messages: [{ role: 'user', content: `Classify this document:\n\n${rawText.slice(0, 8000)}` }],
    tools: [classifyTool],
    tool_choice: { type: 'tool', name: 'classify_document' },
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error('Model did not return a tool_use block');

  const result = classificationResultSchema.parse(toolUse.input);
  logCost('classification', context, response.usage.input_tokens, response.usage.output_tokens);
  return { result, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

function classifyMock(context: { documentId: string }): { result: ClassificationResult; inputTokens: number; outputTokens: number } {
  logger.info({ ...context }, '[Anthropic] Using mock classification (no ANTHROPIC_API_KEY)');
  return { result: { docType: 'invoice', confidence: 0.96 }, inputTokens: 0, outputTokens: 0 };
}

export async function classifyDocument(rawText: string, context: { documentId: string }): Promise<ClassificationResult> {
  if (!hasApiKey() && env.ALLOW_MOCK_PROCESSING) {
    observeProviderCall('anthropic', 'classification', 'success');
    return classifyMock(context).result;
  }
  if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not configured');

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { result } = await classifyReal(rawText, context);
      observeProviderCall('anthropic', 'classification', 'success');
      return result;
    } catch (err) {
      lastError = err;
      observeProviderCall('anthropic', 'classification', 'error');
      logger.warn({ ...context, attempt, err }, '[Anthropic] Classification attempt failed');
    }
  }
  throw new Error(`Classification failed after ${MAX_RETRIES} attempts: ${String(lastError)}`);
}

// ── Extraction ─────────────────────────────────────────────────────────────────

const extractTool = {
  name: 'extract_invoice',
  description: 'Extract structured invoice data from OCR text, with a separate confidence score (0-1) per field group.',
  input_schema: {
    type: 'object' as const,
    properties: {
      vendor: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          address: { type: ['string', 'null'] },
          taxId: { type: ['string', 'null'] },
        },
        required: ['name', 'address', 'taxId'],
      },
      invoice: {
        type: 'object',
        properties: {
          number: { type: ['string', 'null'] },
          date: { type: ['string', 'null'], description: 'ISO 8601 date' },
          dueDate: { type: ['string', 'null'], description: 'ISO 8601 date' },
        },
        required: ['number', 'date', 'dueDate'],
      },
      totals: {
        type: 'object',
        properties: {
          subtotal: { type: 'number' },
          tax: { type: 'number' },
          total: { type: 'number' },
        },
        required: ['subtotal', 'tax', 'total'],
      },
      lineItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number' },
            unitPrice: { type: 'number' },
            amount: { type: 'number' },
          },
          required: ['description', 'quantity', 'unitPrice', 'amount'],
        },
      },
      confidence: {
        type: 'object',
        description: 'Confidence 0-1 for each field group — kept separate from the extracted values themselves.',
        properties: {
          'vendor.name': { type: 'number' },
          'vendor.address': { type: 'number' },
          'vendor.taxId': { type: 'number' },
          'invoice.number': { type: 'number' },
          'invoice.date': { type: 'number' },
          'invoice.dueDate': { type: 'number' },
          'totals.subtotal': { type: 'number' },
          'totals.tax': { type: 'number' },
          'totals.total': { type: 'number' },
          lineItems: { type: 'number' },
        },
        required: [
          'vendor.name', 'vendor.address', 'vendor.taxId',
          'invoice.number', 'invoice.date', 'invoice.dueDate',
          'totals.subtotal', 'totals.tax', 'totals.total', 'lineItems',
        ],
      },
    },
    required: ['vendor', 'invoice', 'totals', 'lineItems', 'confidence'],
  },
};

async function extractReal(rawText: string, context: { documentId: string }): Promise<{ result: InvoiceExtraction; inputTokens: number; outputTokens: number }> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000, // extraction is bounded — open-ended completions risk garbage at high token counts
    system: 'You extract structured invoice data from OCR text. Use null for fields you cannot find rather than guessing. Score your confidence honestly per field group — low confidence is expected and useful when the OCR text is ambiguous.',
    messages: [{ role: 'user', content: `Extract invoice data from this OCR text:\n\n${rawText.slice(0, 12000)}` }],
    tools: [extractTool],
    tool_choice: { type: 'tool', name: 'extract_invoice' },
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error('Model did not return a tool_use block');

  const result = invoiceExtractionSchema.parse(toolUse.input);
  logCost('extraction', context, response.usage.input_tokens, response.usage.output_tokens);
  return { result, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

function extractMock(context: { documentId: string }): { result: InvoiceExtraction; inputTokens: number; outputTokens: number } {
  logger.info({ ...context }, '[Anthropic] Using mock extraction (no ANTHROPIC_API_KEY)');
  // Deterministic test data matching the plan's own Extraction Model example —
  // taxId (0.72) and dueDate (0.80) are intentionally below the 0.85 default
  // threshold so the decision engine's route-to-review path is exercised too,
  // not just the auto-approve path. Line items sum to $600.00, matching
  // subtotal exactly, so math cross-validation passes.
  const result: InvoiceExtraction = {
    vendor: { name: 'Acme Supplies Ltd', address: '123 Main St, Austin TX', taxId: '47-1234567' },
    invoice: {
      number: `INV-MOCK-${context.documentId.slice(0, 8)}`,
      date: new Date().toISOString().slice(0, 10),
      dueDate: '2024-04-14',
    },
    totals: { subtotal: 600.0, tax: 48.0, total: 648.0 },
    lineItems: [
      { description: 'Widget A', quantity: 10, unitPrice: 25.0, amount: 250.0 },
      { description: 'Widget B', quantity: 5, unitPrice: 50.0, amount: 250.0 },
      { description: 'Service Fee', quantity: 1, unitPrice: 100.0, amount: 100.0 },
    ],
    confidence: {
      'vendor.name': 0.94,
      'vendor.address': 0.88,
      'vendor.taxId': 0.72,
      'invoice.number': 0.97,
      'invoice.date': 0.95,
      'invoice.dueDate': 0.8,
      'totals.subtotal': 0.99,
      'totals.tax': 0.98,
      'totals.total': 0.99,
      lineItems: 0.85,
    },
  };
  return { result, inputTokens: 0, outputTokens: 0 };
}

export async function extractInvoice(
  rawText: string,
  context: { documentId: string },
): Promise<{ extraction: InvoiceExtraction; llmModel: string; inputTokens: number; outputTokens: number }> {
  if (!hasApiKey() && env.ALLOW_MOCK_PROCESSING) {
    observeProviderCall('anthropic', 'extraction', 'success');
    const { result, inputTokens, outputTokens } = extractMock(context);
    return { extraction: result, llmModel: 'mock', inputTokens, outputTokens };
  }
  if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not configured');

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { result, inputTokens, outputTokens } = await extractReal(rawText, context);
      observeProviderCall('anthropic', 'extraction', 'success');
      return { extraction: result, llmModel: MODEL, inputTokens, outputTokens };
    } catch (err) {
      lastError = err;
      observeProviderCall('anthropic', 'extraction', 'error');
      logger.warn({ ...context, attempt, err }, '[Anthropic] Extraction attempt failed');
    }
  }
  throw new Error(`Extraction failed after ${MAX_RETRIES} attempts: ${String(lastError)}`);
}
