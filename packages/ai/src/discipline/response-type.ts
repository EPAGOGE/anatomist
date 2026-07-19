/**
 * Response type recognition — equivalent to the "Est. attempts" annotation
 * on each shot in the video production script.
 *
 * Most platform interactions are routine. Some interactions matter
 * disproportionately. The system recognizes which is which and allocates
 * appropriately.
 *
 *   routine     — quick syntax questions, factual lookups, simple component
 *                 questions.
 *   substantial — architectural discussions, decision reasoning, debugging
 *                 chains.
 *   hero        — first registration response, first project creation, first
 *                 AI partnership conversation; the moments when users decide
 *                 whether the platform is substantive.
 *
 * Classification informs:
 *   - Which model tier to use (routine → Haiku, substantial → Sonnet,
 *     hero → Opus)
 *   - How much context to load (routine: minimal, hero: comprehensive)
 *   - Which pre-flight checks to run (routine: anti-patterns only,
 *     hero: full battery)
 *   - Whether to use layered composition (substantial + hero: yes)
 *   - How much budget to allocate (routine: minimal, hero: substantial)
 */

export type ResponseType = 'routine' | 'substantial' | 'hero';

export interface ResponseTypeContext {
  query: string;
  isFirstInteraction: boolean;
  isFirstProjectMessage: boolean;
  projectStage: string | null;
  sessionLength: number;
  queryComplexity: 'simple' | 'moderate' | 'complex';
}

/**
 * Classify a response based on context.
 *
 * Hero moments are explicit recognition of disproportionately important
 * interactions; they get full attention regardless of query simplicity.
 * The default is routine — the discipline only escalates when the signals
 * warrant it.
 */
export function classifyResponse(ctx: ResponseTypeContext): ResponseType {
  // Hero moments: first interactions establish platform character at the
  // moments that matter most for retention. Even if the query itself is
  // simple, a first message deserves the full attention budget.
  if (ctx.isFirstInteraction) return 'hero';
  if (ctx.isFirstProjectMessage) return 'hero';

  // Substantial: complex queries OR substantial project context.
  if (ctx.queryComplexity === 'complex') return 'substantial';
  if (ctx.projectStage === 'architecture' && ctx.queryComplexity !== 'simple') {
    return 'substantial';
  }
  if (ctx.sessionLength > 20 && ctx.queryComplexity === 'moderate') {
    return 'substantial';
  }

  // Default: routine.
  return 'routine';
}

/**
 * Query complexity heuristic — fast deterministic classification without
 * an API call. The cheap signal that informs response type before the
 * orchestrator commits to a model tier. A future ADR may upgrade this to
 * a learned classifier; the deterministic version ships now so routing
 * isn't gated on Phase 1+ infrastructure.
 */
export function estimateQueryComplexity(query: string): 'simple' | 'moderate' | 'complex' {
  const wordCount = query.split(/\s+/).filter(Boolean).length;
  const sentenceCount = (query.match(/[.!?](?=\s|$)/g) ?? []).length;
  const hasArchitecturalTerms = /architect|design|tradeoff|approach|strategy|consideration/i.test(
    query,
  );
  const hasMultipleQuestions = (query.match(/\?/g)?.length ?? 0) > 1;
  // A query is "context-laden" when it either reaches the word threshold
  // OR runs to multiple sentences with architectural framing — both shapes
  // signal "the user is laying out a substantial decision."
  const hasContextSetup = wordCount >= 40 || sentenceCount >= 3;

  if (wordCount > 100 || (hasArchitecturalTerms && hasContextSetup)) {
    return 'complex';
  }
  if (wordCount > 30 || hasArchitecturalTerms || hasMultipleQuestions) {
    return 'moderate';
  }
  return 'simple';
}
