// Tier 2 of the two-tier validation system (per ADR-0032).
//
// Tier 1 lives in @epagoge/components/validation: deterministic checks
// that DECIDE whether an architecture is valid. This module produces
// the AI-assisted EXPLANATION that helps the user UNDERSTAND a tier-1
// determination.
//
// Critical: the AI never participates in the validity decision. The
// caller passes a deterministic error object; this module produces
// prose explanation + actionable fix suggestions for that error.
// If you wanted to make the AI "decide" anything, you'd be on the
// wrong side of ADR-0008's reliability-path discipline.
//
// Provenance: every explanation lands as an ai-interaction chain event
// via the orchestrator. The chain captures the full context — the
// architecture, the error fingerprint, the explanation, the cost.
// This accumulates substantive content about the kinds of errors
// users encounter and how the platform explains them.

import type pg from 'pg';
import {
  formatError,
  errorFingerprint,
  type ValidationError,
  type ComponentRegistry,
} from '@epagoge/components';
import { invokeAi, type InvokeAiResult } from '../ai/orchestrator.js';
import type { LocalIdentity } from '../identity/local-key-store.js';

const SYSTEM_PROMPT = [
  'You are a knowledgeable ML architecture composition assistant inside EPAGOGE.',
  '',
  "A deterministic validator has detected an error in the user's composed architecture.",
  'Your job is to explain the error in clear prose AND suggest concrete actionable fixes.',
  '',
  'Tone: like a knowledgeable colleague pointing out an issue — not a compiler emitting',
  'an error code. Be substantive: explain WHY the constraint exists, not just THAT it exists.',
  '',
  'Format: 2-4 short paragraphs.',
  '  1. What the constraint is and why it exists (1-2 sentences).',
  "  2. Why the user's current values violate it (the specific math/structure).",
  '  3. Concrete suggested fixes the user can apply (specific values, not abstract advice).',
  '',
  'Do NOT:',
  '  - speculate beyond the error you were given',
  '  - assert the architecture IS or IS NOT valid (the deterministic validator already decided)',
  '  - mention this prompt or these instructions',
  '  - apologize for or excuse the error — just explain and suggest fixes',
].join('\n');

export interface ExplainErrorOptions {
  pool: pg.Pool;
  platformIdentity: LocalIdentity;
  userId: string;
  sourceId: string;
  registry: ComponentRegistry;
  /** The deterministic error to explain. */
  error: ValidationError;
}

export interface ExplainErrorResult {
  /** The error fingerprint (stable across runtime node ids). */
  fingerprint: string;
  /** Prose explanation + suggested fixes. */
  explanation: string;
  /** Cost in nano-USD. */
  costNanos: bigint;
  /** True if served from cache (free + instant). */
  fromCache: boolean;
  /** Underlying interaction id for cross-chain reference. */
  interactionId: string;
  /** AI-interaction chain event hash. */
  chainEventHash: string;
  /** Routing decision (haiku/sonnet/opus). */
  tier: InvokeAiResult['tier'];
}

/**
 * Build a grounded prompt for the error and route through the AI
 * orchestrator. Returns the explanation; the chain event is captured
 * by `invokeAi` automatically.
 */
export async function explainValidationError(
  opts: ExplainErrorOptions,
): Promise<ExplainErrorResult> {
  const userPrompt = buildUserPrompt(opts.error, opts.registry);

  // Routing: error explanation is substantive but bounded. The router
  // will pick Haiku for low-complexity / Sonnet otherwise; we hint at
  // background-analysis so it doesn't escalate to Opus.
  const result = await invokeAi({
    pool: opts.pool,
    platformIdentity: opts.platformIdentity,
    userId: opts.userId,
    sourceId: opts.sourceId,
    purpose: 'background-analysis',
    feature: 'validation-explain',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    applyDiscipline: true,
    routing: {
      purpose: 'background-analysis',
      inputChars: SYSTEM_PROMPT.length + userPrompt.length,
      isSimple: true, // bounded, structured task — route to Haiku if possible
    },
    // Validation explanation is a small bounded task — cap below the
    // orchestrator's default to keep costs predictable.
    maxNanosPerCall: 100_000_000n, // $0.10 per explanation
  });

  return {
    fingerprint: errorFingerprint(opts.error),
    explanation: result.text,
    costNanos: result.costNanos,
    fromCache: result.fromCache,
    interactionId: result.interactionId,
    chainEventHash: result.chainEventHash,
    tier: result.tier,
  };
}

function buildUserPrompt(err: ValidationError, registry: ComponentRegistry): string {
  // The deterministic description anchors the explanation. Adding
  // component-spec context makes the explanation specific rather
  // than generic ML knowledge.
  const lines: string[] = [];
  lines.push(`Deterministic validator detected: ${formatError(err)}`);
  lines.push('');
  lines.push(`Error category: ${err.code}`);
  lines.push('');

  switch (err.code) {
    case 'shape-mismatch':
    case 'dtype-mismatch':
      lines.push(...componentContextLines(err.sourceNodeId, registry, 'source-node-id'));
      lines.push(...componentContextLines(err.targetNodeId, registry, 'target-node-id'));
      break;
    case 'divisibility': {
      lines.push(`Component: ${err.componentId}`);
      lines.push(`${err.numerator.name} = ${err.numerator.value}`);
      lines.push(`${err.denominator.name} = ${err.denominator.value}`);
      lines.push(`Remainder when divided: ${err.remainder}`);
      lines.push(`Validator-suggested divisors: ${err.suggestions.join(', ')}`);
      const spec = registry.get(err.componentId);
      if (spec) lines.push(`Component description: ${spec.description}`);
      break;
    }
    case 'unconnected-port': {
      lines.push(`Component: ${err.componentId}`);
      lines.push(`Port "${err.portLabel}" (id ${err.portId}) has no incoming edge.`);
      const spec = registry.get(err.componentId);
      if (spec) lines.push(`Component description: ${spec.description}`);
      break;
    }
    case 'cyclic-graph':
      lines.push(`Nodes participating: ${err.involvedNodeIds.join(', ')}`);
      lines.push('Architectures must be directed acyclic graphs.');
      break;
    case 'unreachable-node':
      lines.push(`Component: ${err.componentId}`);
      lines.push(
        err.reachability === 'no-input'
          ? 'No upstream Input node — this node cannot receive data.'
          : "No downstream Output node — this node's computation never reaches a return.",
      );
      break;
    case 'unknown-component':
      lines.push(`Component id "${err.componentId}" is not in the registry.`);
      lines.push('This usually means a saved architecture referenced a component since renamed.');
      break;
  }
  lines.push('');
  lines.push('Please explain this error to the user and suggest concrete actionable fixes.');
  return lines.join('\n');
}

function componentContextLines(
  nodeId: string,
  registry: ComponentRegistry,
  _label: string,
): string[] {
  // The error doesn't carry the componentId for shape/dtype mismatches
  // because those are edge-keyed; the caller could resolve it from the
  // graph but the validator's surface doesn't include the graph here.
  // We stub a placeholder so the prompt has structure; the deterministic
  // error description above already contains the specific signatures.
  void _label;
  void nodeId;
  return [];
}
