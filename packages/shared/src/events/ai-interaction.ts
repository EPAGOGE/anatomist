// AI-interaction chain payloads. One event per Anthropic API call.
//
// The event captures full provenance: which user/source asked, which model
// answered, how many tokens flowed each way, what it cost, what purpose
// the platform was using AI for, and what context-selection signals
// drove the prompt assembly. Per ADR-0008, AI never sits on the
// reliability path — this chain records AI USE, not reliability evidence.
//
// Cost amounts are integer **nano-USD** (1 USD = 1e9 nanoUSD). This keeps
// budget arithmetic exact and fits comfortably in a 64-bit signed bigint
// (max ~$9 × 10^9 in a single field). The chain payload schema serializes
// these as JSON numbers via z.coerce — CBOR roundtripping preserves them
// as bigint per ADR-0007's z.coerce.bigint() pattern elsewhere.

import { z } from 'zod';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const NanoUsd = z.coerce.bigint().min(0n).max(0xffffffffffffffffn);
const TokenCount = z.number().int().min(0);

export const AI_PURPOSES = [
  'chat',
  'reasoning-capture',
  'recognition-pattern',
  'synthetic-derivation',
  'background-analysis',
  'doctor-roundtrip',
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export const AI_TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type AiTier = (typeof AI_TIERS)[number];

export const AI_FINISH_REASONS = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
] as const;

/** A single AI request/response on the ai-interaction chain. */
export const AiInteractionEventSchema = z.object({
  kind: z.literal('ai-interaction'),
  details: z.object({
    /** Anthropic request id (req_...), if returned. Useful for support. */
    request_id: z.string().min(1).max(128).optional(),
    /** UUID minted by the platform per interaction. Stable across retries. */
    interaction_id: z.string().uuid(),

    /** Initiator. user_id is the users.id (UUID); source_id is the chain
     * source. user-initiated calls carry both; background jobs carry
     * source_id only ('platform' or a task-runner id) and omit user_id. */
    user_id: z.string().uuid().optional(),
    source_id: z.string().min(1).max(255),

    /** Why the platform was calling AI. Drives cost attribution. */
    purpose: z.enum(AI_PURPOSES),
    /** Optional project association for per-project cost analytics. */
    project_id: z.string().uuid().optional(),
    /** Free-form platform-feature label, e.g. 'composer-suggest'. */
    feature: z.string().min(1).max(128).optional(),

    /** Model used (exact Anthropic id) + the tier it was routed to. */
    model: z.string().min(1).max(64),
    tier: z.enum(AI_TIERS),
    /** True iff the response was a deterministic-cache hit (no API call). */
    cache_hit_local: z.boolean(),
    /** True iff Anthropic's prompt cache returned cached input tokens. */
    cache_hit_prompt: z.boolean(),

    /** Token accounting (Anthropic billing semantics). */
    tokens: z.object({
      input: TokenCount,
      output: TokenCount,
      cache_read: TokenCount,
      cache_write: TokenCount,
    }),

    /** Cost breakdown in nano-USD (integer). cost_total = sum of components. */
    cost: z.object({
      input_nanos: NanoUsd,
      output_nanos: NanoUsd,
      cache_read_nanos: NanoUsd,
      cache_write_nanos: NanoUsd,
      total_nanos: NanoUsd,
    }),

    /** Wall-clock duration of the interaction including network. */
    duration_ms: z.number().int().nonnegative(),

    /** How the model finished (per Anthropic stop_reason). */
    finish_reason: z.enum(AI_FINISH_REASONS).optional(),

    /** BLAKE3 hex of the canonical prompt sent to the model (system+messages
     * canonical-cbor encoded). Lets future replays verify the exact input. */
    prompt_hash: Hex64,
    /** BLAKE3 hex of the response text (concatenated text-deltas). */
    response_hash: Hex64,
    /** Optional system-prompt template identifier — for catalog-tracked
     * prompts that ship with the platform. */
    system_prompt_id: z.string().min(1).max(128).optional(),

    /** Context selection metadata. Records what went into the prompt without
     * embedding the prose itself. Per ADR-0023. */
    context_selection: z
      .object({
        strategy: z.string().min(1).max(64),
        included_chain_events: z.array(Hex64).max(64).optional(),
        included_project_ids: z.array(z.string().uuid()).max(16).optional(),
        recency_window_events: z.number().int().nonnegative().optional(),
        relevance_threshold: z.number().min(0).max(1).optional(),
        total_context_tokens: TokenCount.optional(),
      })
      .optional(),

    /** ISO 8601 timestamp of when the interaction completed. */
    occurred_at: z.string(),
  }),
});

export type AiInteractionEventPayload = z.infer<typeof AiInteractionEventSchema>;
export type AiInteractionDetails = AiInteractionEventPayload['details'];
