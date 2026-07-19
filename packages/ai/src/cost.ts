// Cost computation. Single source of truth for translating Anthropic
// token-usage figures into nano-USD integer amounts the rest of the
// platform consumes.
//
// nano-USD: 1 USD = 1_000_000_000 nanoUSD. Integer arithmetic preserves
// precision (one Opus output token costs $0.000025 = 25,000 nanoUSD).
// Budget enforcement is straight bigint comparison; no float drift.

import { MODEL_SPECS, type ModelId } from './models.js';

export const NANOS_PER_USD = 1_000_000_000n;

export interface AnthropicTokenUsage {
  /** Tokens that hit the model (not in cache). */
  inputTokens: number;
  /** Output tokens generated. */
  outputTokens: number;
  /** Cached tokens served from Anthropic prompt cache. */
  cacheReadInputTokens?: number;
  /** Tokens written to Anthropic prompt cache this request. */
  cacheCreationInputTokens?: number;
  /** Optional: cache TTL the write used. Defaults to '5m'. */
  cacheTtl?: '5m' | '1h';
}

export interface CostBreakdown {
  inputNanos: bigint;
  outputNanos: bigint;
  cacheReadNanos: bigint;
  cacheWriteNanos: bigint;
  totalNanos: bigint;
}

/**
 * nanoUSD cost of `tokens` at the given per-MTok USD price, integer math
 * with half-up rounding.
 *
 *   cost_nanos = tokens * perMTokUsd * 1e9 / 1e6
 *              = tokens * (perMTokUsd * 1e9) / 1e6
 *
 * `perMTokUsd * 1e9` is the integer nanoUSD per MTok (e.g. Opus output =
 * 25_000_000_000). Dividing by 1e6 tokens/MTok gives nanoUSD per token,
 * and we apply the half-up adjustment before the final divide.
 */
function tokenCostNanos(tokens: number, perMTokUsd: number): bigint {
  if (tokens <= 0) return 0n;
  const nanosPerMTok = BigInt(Math.round(perMTokUsd * 1_000_000_000));
  // half-up: add 1/2 of the divisor before the integer divide
  return (BigInt(tokens) * nanosPerMTok + 500_000n) / 1_000_000n;
}

/**
 * Compute the full cost breakdown for one Anthropic API call.
 * All amounts are integer nanoUSD. total = input + output + cache_read + cache_write.
 */
export function computeCost(model: ModelId, usage: AnthropicTokenUsage): CostBreakdown {
  const spec = MODEL_SPECS[model];
  const { pricing } = spec;

  const inputNanos = tokenCostNanos(usage.inputTokens, pricing.inputPerMTok);
  const outputNanos = tokenCostNanos(usage.outputTokens, pricing.outputPerMTok);
  const cacheReadNanos = tokenCostNanos(usage.cacheReadInputTokens ?? 0, pricing.cacheReadPerMTok);
  const writeRate =
    usage.cacheTtl === '1h' ? pricing.cacheWrite1hPerMTok : pricing.cacheWrite5mPerMTok;
  const cacheWriteNanos = tokenCostNanos(usage.cacheCreationInputTokens ?? 0, writeRate);
  const totalNanos = inputNanos + outputNanos + cacheReadNanos + cacheWriteNanos;

  return { inputNanos, outputNanos, cacheReadNanos, cacheWriteNanos, totalNanos };
}

export function nanosToUsd(nanos: bigint): number {
  // For display only. Use bigints for arithmetic and comparisons.
  return Number(nanos) / Number(NANOS_PER_USD);
}

export function usdToNanos(usd: number): bigint {
  return BigInt(Math.round(usd * Number(NANOS_PER_USD)));
}

/** Format nanos as a USD string for display. e.g. 5_000_000n -> "$0.005000". */
export function formatNanosUsd(nanos: bigint, precision = 6): string {
  const usd = nanosToUsd(nanos);
  return `$${usd.toFixed(precision)}`;
}
