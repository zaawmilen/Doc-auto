import { describe, expect, it } from 'vitest';
import { extractionJobId, ocrJobId } from '../../src/queues/jobIds.js';

describe('queue job IDs', () => {
  it('returns stable, queue-specific IDs for a document', () => {
    const documentId = '00000000-0000-0000-0000-000000000001';

    expect(ocrJobId(documentId)).toBe(`ocr:${documentId}:initial`);
    expect(extractionJobId(documentId)).toBe(`extraction:${documentId}:initial`);
    expect(ocrJobId(documentId, 'retry-1')).not.toBe(ocrJobId(documentId, 'retry-2'));
    expect(ocrJobId(documentId)).not.toBe(extractionJobId(documentId));
  });
});