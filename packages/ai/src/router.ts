// Model router. Classifies an incoming task into a tier
// (haiku | sonnet | opus) using heuristics on the request shape.
//
// Per ADR-0021 the routing decision is the platform's, not the user's:
// users say what they want done; the router decides which model to use
// so the platform's unit economics improve measurably over an all-Opus
// baseline. Explicit overrides (an upstream caller insisting on a tier)
// are honored when present.
//
// Routing inputs are simple and observable: input length, presence of
// reasoning markers, presence of code, purpose tag. The classifier
// errs toward Sonnet (the workhorse) when uncertain, escalates to
// Opus when reasoning/depth signals are present, and drops to Haiku
// only when the task is unambiguously simple.

import { MODELS, type ModelId, type ModelTier, modelForTier, type ModelSpec } from './models.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RoutingInput {
  /** What the platform is using AI for. */
  purpose:
    | 'chat'
    | 'reasoning-capture'
    | 'recognition-pattern'
    | 'synthetic-derivation'
    | 'background-analysis'
    | 'doctor-roundtrip';
  /** Approximate input length in characters; cheap pre-flight estimate. */
  inputChars: number;
  /** True if the task involves multi-step reasoning, derivation, or
   *  code-generation that benefits from depth. */
  needsReasoning?: boolean;
  /** True if the task is short, factual, classification-like, or
   *  latency-sensitive. */
  isSimple?: boolean;
  /** Explicit tier the caller insists on. When set, routing is a no-op. */
  forceTier?: ModelTier;
  /** Explicit model id. Overrides forceTier when set. */
  forceModel?: ModelId;
  /** Whether the caller plans to use adaptive thinking. Affects effort. */
  thinkingMode?: 'adaptive' | 'disabled';
}

export interface RoutingDecision {
  readonly model: ModelId;
  readonly tier: ModelTier;
  readonly effort: Effort;
  readonly thinking: { type: 'adaptive' } | { type: 'disabled' };
  readonly rationale: string;
  readonly spec: ModelSpec;
}

const REASONING_PURPOSES = new Set([
  'reasoning-capture',
  'synthetic-derivation',
  'recognition-pattern',
]);

const SIMPLE_PURPOSES = new Set(['doctor-roundtrip']);

/**
 * The classifier. Returns a complete routing decision including effort
 * and thinking mode. Decision is deterministic given the input — no
 * randomness, no learned weights, no AI involved.
 */
export function route(input: RoutingInput): RoutingDecision {
  // 1. Explicit overrides win.
  if (input.forceModel) {
    return decision(
      input.forceModel,
      'medium',
      input.thinkingMode ?? 'disabled',
      'explicit force-model',
    );
  }
  if (input.forceTier) {
    return decision(
      MODELS[input.forceTier],
      'medium',
      input.thinkingMode ?? 'disabled',
      'explicit force-tier',
    );
  }

  // 2. Purpose-based classification.
  if (SIMPLE_PURPOSES.has(input.purpose)) {
    return decision(MODELS.haiku, 'low', 'disabled', 'doctor-roundtrip → haiku/low');
  }
  if (REASONING_PURPOSES.has(input.purpose)) {
    return decision(MODELS.opus, 'high', 'adaptive', 'reasoning purpose → opus/high/adaptive');
  }

  // 3. Signal-based classification for chat / background-analysis.
  if (input.isSimple === true) {
    return decision(MODELS.haiku, 'low', 'disabled', 'isSimple flag → haiku/low');
  }
  // needsReasoning → Opus. Counterintuitive but EMPIRICALLY VERIFIED
  // by F-0 Criterion 6 measurement and re-measurement (see ADR-0038):
  // Sonnet 4.6 with adaptive thinking generates ~2x the output
  // tokens Opus 4.7 generates on substantial-reasoning chat
  // queries. Sonnet's lower per-token rate does NOT compensate;
  // routed-to-Sonnet ended up costing -37% vs Opus-only on the
  // representative workload. The first instinct ("middle tier
  // unused, reactivate Sonnet") was overturned by the data.
  // Conclusion: on this kind of workload Opus is the cost-optimal
  // choice for reasoning queries because it is output-efficient.
  // Sonnet is reachable via REASONING_PURPOSES (handled above) and
  // the length-based fallback below; chat traffic that signals
  // needsReasoning correctly goes to Opus.
  if (input.needsReasoning === true) {
    return decision(MODELS.opus, 'high', 'adaptive', 'needsReasoning flag → opus/high/adaptive');
  }

  // 4. Length-based fallback.
  // Very short inputs (< 200 chars) → haiku for latency.
  // Most everything else → sonnet (the workhorse).
  // Long inputs (> 20K chars) → opus only when reasoning is also signalled
  // (already handled above); otherwise sonnet handles it fine.
  if (input.inputChars < 200) {
    return decision(MODELS.haiku, 'low', 'disabled', 'short input < 200ch → haiku/low');
  }

  return decision(
    MODELS.sonnet,
    'medium',
    input.thinkingMode ?? 'disabled',
    'default workhorse → sonnet/medium',
  );
}

function decision(
  model: ModelId,
  effort: Effort,
  thinkingMode: 'adaptive' | 'disabled',
  rationale: string,
): RoutingDecision {
  const spec = modelForTier(
    ((Object.keys(MODELS) as ModelTier[]).find((t) => MODELS[t] === model) ??
      'sonnet') as ModelTier,
  );

  // Effort sanity: cap to what the model supports.
  let safeEffort: Effort = effort;
  if (safeEffort === 'max' && !spec.capabilities.effortMax) safeEffort = 'high';
  if (safeEffort === 'xhigh' && !spec.capabilities.effortXhigh) safeEffort = 'high';

  return {
    model,
    tier: spec.tier,
    effort: safeEffort,
    thinking: thinkingMode === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' },
    rationale,
    spec,
  };
}

export { MODELS, type ModelId, type ModelTier };
