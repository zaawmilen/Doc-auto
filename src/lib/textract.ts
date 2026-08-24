import { env } from '../config/env.js';
import { logger } from './logger.js';
import { observeProviderCall } from './metrics.js';

export interface OcrResult {
  rawText: string;
  blockCount: number;
}

function hasAwsCredentials(): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/**
 * Real OCR via AWS Textract's synchronous DetectDocumentText API.
 * Note: sync Textract only supports single-page PDF/PNG/JPEG under 5MB.
 * Multi-page PDFs need the async StartDocumentTextDetection + S3 flow —
 * flagged as a Week 3+ hardening item once volume requires it.
 */
async function detectTextReal(buffer: Buffer, context: { documentId: string }): Promise<OcrResult> {
  const { TextractClient, DetectDocumentTextCommand } = await import('@aws-sdk/client-textract');
  const client = new TextractClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
    },
  });

  const response = await client.send(new DetectDocumentTextCommand({
    Document: { Bytes: buffer },
  }));

  const lines = (response.Blocks ?? [])
    .filter((b) => b.BlockType === 'LINE' && b.Text)
    .map((b) => b.Text as string);

  logger.info({ ...context, blockCount: response.Blocks?.length ?? 0, lineCount: lines.length }, '[OCR] Textract detection complete');

  return { rawText: lines.join('\n'), blockCount: response.Blocks?.length ?? 0 };
}

function detectTextMock(fileName: string, context: { documentId: string }): OcrResult {
  logger.info({ ...context, fileName }, '[OCR] Using mock OCR (no AWS credentials)');
  const rawText = [
    'Acme Supplies Ltd',
    '123 Main St, Austin TX',
    'Tax ID: 47-1234567',
    `Invoice #: INV-MOCK-${context.documentId.slice(0, 8)}`,
    `Invoice Date: ${new Date().toISOString().slice(0, 10)}`,
    'Due Date: 2024-04-14',
    '',
    'Description          Qty   Unit Price   Amount',
    'Widget A              10       $25.00    $250.00',
    'Widget B               5       $50.00    $250.00',
    'Service Fee            1      $100.00    $100.00',
    '',
    'Subtotal: $600.00',
    'Tax: $48.00',
    'Total: $648.00',
    '',
    `[MOCK OCR OUTPUT — source file: ${fileName} — set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY for real Textract calls]`,
  ].join('\n');
  return { rawText, blockCount: rawText.split('\n').length };
}

export async function extractText(
  buffer: Buffer,
  fileName: string,
  context: { documentId: string },
): Promise<OcrResult> {
  if (hasAwsCredentials()) {
    try {
      const result = await detectTextReal(buffer, context);
      observeProviderCall('textract', 'ocr', 'success');
      return result;
    } catch (error) {
      observeProviderCall('textract', 'ocr', 'error');
      throw error;
    }
  }
  if (!env.ALLOW_MOCK_PROCESSING) {
    throw new Error('AWS credentials are not configured');
  }
  observeProviderCall('textract', 'ocr', 'success');
  return detectTextMock(fileName, context);
}
