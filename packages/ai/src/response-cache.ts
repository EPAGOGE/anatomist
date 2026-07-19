// Platform-level response cache for deterministic queries.
//
// Distinct from Anthropic's own prompt cache (which discounts repeated
// PREFIX content). This cache memoizes complete (request → response)
// pairs that are known to be deterministic — same model, same system
// prompt, same messages, same effort, no thinking, no temperature.
//
// Typical use cases:
//   - Classification calls ("is this query a question or a statement?")
//   - Reasoning-capture summarization (canonical short prose from a
//     fixed input)
//   - Doctor round-trip sanity checks
//
// Things this cache must NEVER memoize:
//   - Anything user-facing or personalized (per-user content)
//   - Streamed chat (responses vary on each call)
//   - Anything with adaptive thinking (output varies)
//   - Anything with effort >= medium that may reason differently

import { blake3 } from '@epagoge/crypto';
import { encodeCanonicalCbor } from '@epagoge/shared';
import type { ChatMessage, SystemPromptSegment } from './client.js';
import type { ModelId } from './models.js';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface CacheKeyInputs {
  model: ModelId;
  /** System prompt segments OR a flat string. */
  system?: string | readonly SystemPromptSegment[];
  messages: readonly ChatMessage[];
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Must be 'disabled' for cache eligibility. */
  thinking: { type: 'disabled' };
}

/**
 * Compute a 64-char hex cache key from the canonical CBOR encoding of
 * the inputs. Order-stable (canonical CBOR sorts keys); any byte change
 * in any field produces a different key.
 */
export function computeCacheKey(inputs: CacheKeyInputs): string {
  // Normalize system to a flat list (drop cache_control hints which
  // don't affect the response).
  let sys: string | undefined;
  if (typeof inputs.system === 'string') {
    sys = inputs.system;
  } else if (inputs.system) {
    sys = inputs.system.map((s) => s.text).join('\n');
  }
  const canonical = {
    v: 1,
    model: inputs.model,
    effort: inputs.effort ?? 'low',
    system: sys ?? '',
    messages: inputs.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const bytes = encodeCanonicalCbor(canonical);
  return bytesToHex(blake3.hash(bytes));
}

/** Heuristic predicate: is this set of inputs eligible for caching at all? */
export function isCacheable(inputs: {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinking?: { type: 'adaptive' } | { type: 'disabled' };
}): boolean {
  if (inputs.thinking?.type === 'adaptive') return false;
  // Reserve caching for low/medium effort. Higher effort means the model
  // is likely to reason differently across calls.
  const effort = inputs.effort ?? 'low';
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return false;
  return true;
}
