/**
 * Pre-flight pattern tripwire — NOT a quality gate.
 *
 * Honest accounting (added in tranche 5 after I oversold this module
 * earlier): this is regex-based pattern matching against a small catalogue
 * of well-known AI-response anti-patterns. It catches:
 *
 *   - Common opener-sycophancy ("Great question!", "What a fascinating...")
 *   - Hollow encouragement ("you got this", "keep up the great work")
 *   - Verbose padding ("In conclusion,", "To summarize,")
 *   - Severe disclaimer-stacking (≥3 hedges in a short response)
 *   - Multiple unhedged absolutes ("always", "never", "definitely")
 *
 * It does NOT catch — and should not be claimed to catch:
 *
 *   - Factual inaccuracy
 *   - Off-topic responses that don't actually answer the question
 *   - Stylistic register mismatches (overly formal where casual fits, etc.)
 *   - Mid-response sycophancy (most regexes are anchored to the opening)
 *   - Anything an adversary or a smart model could trivially route around
 *
 * The real quality lever is the rhythm guidance in the system prompt
 * (response-type → expected shape/length/tone), which steers the model
 * away from generating these patterns in the first place. This tripwire
 * exists for the cases where it slips through anyway.
 *
 * Cost: microseconds per response. Value: catches the most embarrassing
 * openings, nothing more. Treat the "passed/recommendation" output as
 * "did any cheap tripwire fire?" — not as "is this a quality response?"
 *
 * Deterministic by design — no AI calls. Putting an LLM in the gate would
 * create a quality-checks-the-quality-checker loop and violate ADR-0008.
 * A future tranche may add an OPTIONAL LLM-judge supplement gated on
 * hero responses, where the per-call cost is justified by the stakes.
 */

export type QualityIssue = {
  category: 'anti-pattern' | 'substance' | 'calibration' | 'consistency';
  severity: 'minor' | 'significant' | 'reject';
  description: string;
  example?: string;
};

export type QualityCheckResult = {
  passed: boolean;
  issues: QualityIssue[];
  recommendation: 'send' | 'revise' | 'regenerate';
};

export interface QualityCheckParams {
  query: string;
  draftResponse: string;
  responseType: 'routine' | 'substantial' | 'hero';
}

/**
 * Anti-pattern catalogue — parallel to the NEGATIVE PROMPT in the video
 * production script. Knowing what to refuse is as important as knowing
 * what to produce. Each entry is a regex that matches a recognized
 * AI-response anti-pattern; presence is a flag, not a hard reject (the
 * severity is decided per response type).
 */
export const ANTI_PATTERNS = {
  // Generic motivational openings.
  GREAT_QUESTION: /^(great|wonderful|excellent|fantastic|amazing) question/i,
  WHAT_A: /^what (a|an) (great|wonderful|fascinating|interesting)/i,
  GLAD_TO_HELP: /(happy|glad) to help/i,

  // Hollow encouragement.
  YOU_GOT_THIS: /you('ve| have) (got|this)/i,
  KEEP_UP: /keep (up|going) the (great|good|excellent)/i,

  // Performed agreement (without substance).
  ABSOLUTELY: /^(absolutely|definitely|certainly)[!.]/i,

  // Verbose padding.
  IN_CONCLUSION: /^in conclusion,?/im,
  TO_SUMMARIZE: /^to (sum up|summarize)/im,

  // Sycophantic praise.
  // Match "that's clever ..." AND "that's a clever ..." — both shapes
  // show up in the wild as sycophantic openings.
  CLEVER_APPROACH: /that('s| is)(?: an?)? (clever|brilliant|smart|inspired)/i,
  GOOD_THINKING: /good (thinking|instinct|catch)/i,
} as const;

/**
 * Substance checks — verify the response actually engages with what was
 * asked. Cheap structural heuristics; not a content judgment.
 */
export function checkSubstance(query: string, draftResponse: string): QualityIssue[] {
  const issues: QualityIssue[] = [];

  // Response substantially shorter than query suggests evasion or low
  // effort. Threshold: query > 100 chars AND response < half its length.
  if (draftResponse.length < query.length / 2 && query.length > 100) {
    issues.push({
      category: 'substance',
      severity: 'significant',
      description: 'Response substantially shorter than query — possible evasion',
    });
  }

  // High disclaimer-to-content ratio.
  const disclaimerPatterns = [
    /I('m| am) (an AI|just|only|simply)/i,
    /I (cannot|can't|don't have)/i,
    /please (consult|verify|check)/i,
  ];
  const disclaimerCount = disclaimerPatterns.filter((p) => p.test(draftResponse)).length;
  if (disclaimerCount >= 3 && draftResponse.length < 500) {
    issues.push({
      category: 'substance',
      severity: 'reject',
      description: 'Response is mostly disclaimers — substantive content insufficient',
    });
  }

  return issues;
}

/**
 * Calibration checks — verify confidence claims are appropriately hedged.
 * Overconfident statements on uncertain topics fail this check.
 */
export function checkCalibration(draftResponse: string): QualityIssue[] {
  const issues: QualityIssue[] = [];

  const overconfidentPatterns = [
    /this (is|will be) (always|never|definitely)/i,
    /it('s| is) impossible to/i,
    /this (must|cannot)/i,
  ];

  const overconfidentCount = overconfidentPatterns.filter((p) => p.test(draftResponse)).length;

  if (overconfidentCount > 2) {
    issues.push({
      category: 'calibration',
      severity: 'minor',
      description: 'Multiple absolute claims — consider whether all warrant such certainty',
    });
  }

  return issues;
}

/**
 * Run pre-flight checks appropriate to response type.
 *
 *   routine     → fast anti-pattern check only (minor severity)
 *   substantial → anti-pattern (significant) + substance + calibration
 *   hero        → same as substantial; future ADR may add deeper checks
 */
export function preFlightCheck(params: QualityCheckParams): QualityCheckResult {
  const { query, draftResponse, responseType } = params;
  const issues: QualityIssue[] = [];

  // Anti-pattern check runs for every response type. Severity is upgraded
  // for substantial / hero because a hollow opening in those contexts is
  // more damaging than the same opening in a routine reply.
  for (const [name, pattern] of Object.entries(ANTI_PATTERNS)) {
    const match = draftResponse.match(pattern);
    if (match) {
      issues.push({
        category: 'anti-pattern',
        severity: responseType === 'routine' ? 'minor' : 'significant',
        description: `Anti-pattern detected: ${name}`,
        example: match[0],
      });
    }
  }

  // Substance + calibration run on substantial and hero responses only.
  if (responseType !== 'routine') {
    issues.push(...checkSubstance(query, draftResponse));
    issues.push(...checkCalibration(draftResponse));
  }

  const hasReject = issues.some((i) => i.severity === 'reject');
  const hasSignificant = issues.some((i) => i.severity === 'significant');

  const recommendation: 'send' | 'revise' | 'regenerate' = hasReject
    ? 'regenerate'
    : hasSignificant
      ? 'revise'
      : 'send';

  return {
    passed: !hasReject,
    issues,
    recommendation,
  };
}
