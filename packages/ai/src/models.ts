// Anthropic model registry with pricing as of the claude-api skill cache
// (2026-04-29). Prices are USD per million tokens.
//
// Cache pricing modifiers (applied to base input price):
//   cache write 5-minute TTL: 1.25x
//   cache write 1-hour   TTL: 2.00x
//   cache read              : 0.10x
//
// Update this file whenever Anthropic publishes new pricing. The cost
// module derives all dollar figures from these values.

export const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
} as const;

export type ModelTier = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[ModelTier];

export interface ModelSpec {
  readonly id: ModelId;
  readonly tier: ModelTier;
  readonly displayName: string;
  /** Maximum input context window in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens. Requires streaming above ~16K. */
  readonly maxOutput: number;
  /** Pricing in USD per million tokens. */
  readonly pricing: {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    /** cache read = inputPerMTok * 0.10 */
    readonly cacheReadPerMTok: number;
    /** 5-minute TTL cache write = inputPerMTok * 1.25 */
    readonly cacheWrite5mPerMTok: number;
    /** 1-hour TTL cache write = inputPerMTok * 2.00 */
    readonly cacheWrite1hPerMTok: number;
  };
  /**
   * Capabilities.
   *
   * effortSupported — whether the model accepts the `effort` parameter at all.
   *   Supported on Opus 4.5+ and Sonnet 4.6. Older Sonnet (4.5) and every
   *   Haiku (incl. 4.5) reject the param outright with a 400. Send NOTHING
   *   in `output_config.effort` when this is false.
   * effortMax    — `effort: "max"` is Opus-tier only.
   * effortXhigh  — `effort: "xhigh"` is Opus 4.7-only.
   */
  readonly capabilities: {
    readonly adaptiveThinking: boolean;
    readonly effortSupported: boolean;
    readonly effortMax: boolean;
    readonly effortXhigh: boolean;
    readonly vision: boolean;
    readonly promptCaching: boolean;
    readonly batchApi: boolean;
  };
  /** Minimum cacheable prefix (tokens). Shorter prefixes silently won't cache. */
  readonly minCacheablePrefixTokens: number;
}

function deriveCachePricing(inputPerMTok: number): {
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
} {
  return {
    cacheReadPerMTok: inputPerMTok * 0.1,
    cacheWrite5mPerMTok: inputPerMTok * 1.25,
    cacheWrite1hPerMTok: inputPerMTok * 2.0,
  };
}

export const MODEL_SPECS: Readonly<Record<ModelId, ModelSpec>> = Object.freeze({
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    tier: 'opus',
    displayName: 'Claude Opus 4.7',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    pricing: { inputPerMTok: 5.0, outputPerMTok: 25.0, ...deriveCachePricing(5.0) },
    capabilities: {
      adaptiveThinking: true,
      effortSupported: true,
      effortMax: true,
      effortXhigh: true,
      vision: true,
      promptCaching: true,
      batchApi: true,
    },
    minCacheablePrefixTokens: 4096,
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    tier: 'sonnet',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0, ...deriveCachePricing(3.0) },
    capabilities: {
      adaptiveThinking: true,
      effortSupported: true,
      effortMax: false,
      effortXhigh: false,
      vision: true,
      promptCaching: true,
      batchApi: true,
    },
    minCacheablePrefixTokens: 2048,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    tier: 'haiku',
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricing: { inputPerMTok: 1.0, outputPerMTok: 5.0, ...deriveCachePricing(1.0) },
    capabilities: {
      adaptiveThinking: true,
      // Haiku 4.5 rejects the `effort` parameter outright with a 400 —
      // surfaced by the first live API call against the real platform.
      effortSupported: false,
      effortMax: false,
      effortXhigh: false,
      vision: true,
      promptCaching: true,
      batchApi: true,
    },
    minCacheablePrefixTokens: 4096,
  },
});

export function modelForTier(tier: ModelTier): ModelSpec {
  return MODEL_SPECS[MODELS[tier]];
}

export function specFor(modelId: ModelId): ModelSpec {
  return MODEL_SPECS[modelId];
}

/** Strict type guard. Returns true iff the string is a registered model id. */
export function isRegisteredModel(s: string): s is ModelId {
  return s in MODEL_SPECS;
}
