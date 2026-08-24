export function ocrJobId(documentId: string, processingRunId = 'initial'): string {
  return `ocr:${documentId}:${processingRunId}`;
}

export function extractionJobId(documentId: string, processingRunId = 'initial'): string {
  return `extraction:${documentId}:${processingRunId}`;
}