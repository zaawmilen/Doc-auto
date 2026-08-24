import type { InvoiceExtraction } from '../validators/extraction.js';

export interface DecisionResult {
  decision: 'auto_approve' | 'route_to_review';
  reasons: string[];
  mathValid: boolean;
  lineItemsSum: number;
  minConfidence: number;
}

const MATH_TOLERANCE = 0.01; // $0.01, per the plan's routing logic

/**
 * Auto-approve: all field confidences >= tenant threshold AND lineItems sum
 * matches totals.subtotal within $0.01.
 * Route to review: any field confidence < threshold OR math validation fails
 * OR doc_type = unknown (caller checks doc_type separately before extraction runs).
 */
export function evaluateExtraction(extraction: InvoiceExtraction, threshold: number): DecisionResult {
  const reasons: string[] = [];

  const lineItemsSum = extraction.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const mathValid = Math.abs(lineItemsSum - extraction.totals.subtotal) <= MATH_TOLERANCE;
  if (!mathValid) {
    reasons.push(`Line items sum ($${lineItemsSum.toFixed(2)}) does not match subtotal ($${extraction.totals.subtotal.toFixed(2)})`);
  }

  const confidenceEntries = Object.entries(extraction.confidence);
  const minConfidence = Math.min(...confidenceEntries.map(([, v]) => v));
  const belowThreshold = confidenceEntries.filter(([, v]) => v < threshold);
  for (const [field, value] of belowThreshold) {
    reasons.push(`${field} confidence (${value.toFixed(2)}) is below threshold (${threshold.toFixed(2)})`);
  }

  const decision: DecisionResult['decision'] = mathValid && belowThreshold.length === 0 ? 'auto_approve' : 'route_to_review';

  return { decision, reasons, mathValid, lineItemsSum, minConfidence };
}
