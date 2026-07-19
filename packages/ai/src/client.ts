// Anthropic SDK wrapper. Single entry point for all platform AI calls.
//
// Responsibilities:
//   - Hold the configured Anthropic client (singleton).
//   - Enforce ADR-0008 boundary via assertNotInReliabilityScope.
//   - Run every call through the circuit breaker.
//   - Set sensible defaults: adaptive thinking off by default (callers
//     opt in), prompt caching cache_control on the last system block,
//     streaming for outputs > 16K, max_tokens budgeted per tier.
//   - Surface the SDK's typed Message + Usage objects unchanged so
//     downstream cost.ts can read the canonical token counts.
//
// What this wrapper deliberately does NOT do:
//   - It does not log to a chain (that's the orchestrator's job).
//   - It does not enforce per-user budgets (orchestrator).
//   - It does not pick the model (router).
// Single responsibility: talk to Anthropic with the right safety net.

import Anthropic from '@anthropic-ai/sdk';
import { assertNotInReliabilityScope } from './runtime-guard.js';
import { getBreaker, type CircuitBreaker } from './backoff.js';
import { type ModelId, specFor } from './models.js';
import type { Effort } from './router.js';

let cachedClient: Anthropic | null = null;

export interface AnthropicConfig {
  /** Override the API key. Defaults to ANTHROPIC_API_KEY env. */
  apiKey?: string;
  /** SDK-level retries. Defaults to 2 (the SDK default). */
  maxRetries?: number;
  /** Overall timeout in ms. Defaults to 10 minutes (the SDK default). */
  timeoutMs?: number;
}

export function getClient(config: AnthropicConfig = {}): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set; cannot construct Anthropic client');
  }
  cachedClient = new Anthropic({
    apiKey,
    maxRetries: config.maxRetries ?? 2,
    ...(config.timeoutMs !== undefined ? { timeout: config.timeoutMs } : {}),
  });
  return cachedClient;
}

/** Reset for tests. */
export function resetClient(): void {
  cachedClient = null;
}

export interface SystemPromptSegment {
  /** The actual prompt text. */
  text: string;
  /** Mark as a cache breakpoint. The LAST segment with cacheBreakpoint
   *  set caches tools + system together (see prompt-caching skill). */
  cacheBreakpoint?: boolean;
  /** TTL for the breakpoint. Default '5m'. */
  cacheTtl?: '5m' | '1h';
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CreateMessageOptions {
  model: ModelId;
  /** System prompt. String for simple cases; segment array enables caching. */
  system?: string | readonly SystemPromptSegment[];
  /** Conversation history. */
  messages: readonly ChatMessage[];
  /** Hard ceiling on output tokens. Defaults to a tier-appropriate value. */
  maxTokens?: number;
  /** Effort level. */
  effort?: Effort;
  /** Adaptive thinking config. */
  thinking?: { type: 'adaptive' } | { type: 'disabled' };
  /** Stream the response. When true, this wrapper still returns a complete
   *  Message — the caller wanting token-by-token deltas should call
   *  `streamMessage` instead. */
  stream?: boolean;
}

export interface CreateMessageResult {
  /** The complete Anthropic Message — opaque to callers below the orchestrator. */
  message: Anthropic.Messages.Message;
  /** Wall-clock duration of the call. */
  durationMs: number;
}

const DEFAULT_MAX_TOKENS_BY_TIER = { haiku: 8192, sonnet: 16000, opus: 16000 } as const;

function buildSystemParam(
  system: string | readonly SystemPromptSegment[] | undefined,
): string | Array<Anthropic.Messages.TextBlockParam> | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  return system.map((seg) => {
    const block: Anthropic.Messages.TextBlockParam = { type: 'text', text: seg.text };
    if (seg.cacheBreakpoint) {
      block.cache_control =
        seg.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    }
    return block;
  });
}

function buildOutputConfig(opts: CreateMessageOptions): { effort?: Effort } | undefined {
  if (!opts.effort) return undefined;
  const spec = specFor(opts.model);
  // Models without effort support reject the param outright with a 400
  // (Haiku 4.5, Sonnet 4.5). Return undefined so the API call omits
  // output_config entirely. The router records the requested effort on
  // its decision object for analytics, but we don't send it on the wire.
  if (!spec.capabilities.effortSupported) return undefined;
  let safe = opts.effort;
  if (safe === 'max' && !spec.capabilities.effortMax) safe = 'high';
  if (safe === 'xhigh' && !spec.capabilities.effortXhigh) safe = 'high';
  return { effort: safe };
}

/**
 * Non-streaming message creation. Returns the complete message + duration.
 * Uses the circuit breaker. Refuses to run inside a reliability scope.
 */
export async function createMessage(
  opts: CreateMessageOptions,
  breaker: CircuitBreaker = getBreaker(),
): Promise<CreateMessageResult> {
  assertNotInReliabilityScope('@epagoge/ai.createMessage');
  const client = getClient();
  const spec = specFor(opts.model);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS_BY_TIER[spec.tier];

  const params: Anthropic.Messages.MessageCreateParams = {
    model: opts.model,
    max_tokens: maxTokens,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const sys = buildSystemParam(opts.system);
  if (sys !== undefined) params.system = sys;
  const oc = buildOutputConfig(opts);
  if (oc !== undefined) {
    (params as unknown as { output_config: typeof oc }).output_config = oc;
  }
  if (opts.thinking && opts.thinking.type !== 'disabled') {
    (params as unknown as { thinking: { type: 'adaptive' } }).thinking = { type: 'adaptive' };
  }

  const start = performance.now();
  const message = await breaker.execute(async () => {
    if (opts.stream || maxTokens > 16_000) {
      // The SDK rejects non-streaming requests it estimates will exceed
      // ~10 minutes. Use streaming + finalMessage() to avoid timeouts.
      const stream = (client.messages as { stream: (p: typeof params) => unknown }).stream(params);
      // finalMessage() resolves with the complete Message.
      return (stream as { finalMessage: () => Promise<Anthropic.Messages.Message> }).finalMessage();
    }
    return client.messages.create(params) as Promise<Anthropic.Messages.Message>;
  });
  const durationMs = performance.now() - start;

  return { message, durationMs };
}

/**
 * Streaming message creation. Returns an async iterable of text deltas
 * plus a finalize() that resolves to the complete message after the
 * stream ends. The caller is responsible for driving the iterator.
 */
export interface StreamingResult {
  readonly textStream: AsyncIterable<string>;
  readonly finalMessage: () => Promise<Anthropic.Messages.Message>;
  readonly startedAt: number;
}

export function streamMessage(
  opts: CreateMessageOptions,
  breaker: CircuitBreaker = getBreaker(),
): StreamingResult {
  assertNotInReliabilityScope('@epagoge/ai.streamMessage');
  const client = getClient();
  const spec = specFor(opts.model);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS_BY_TIER[spec.tier];

  const params: Anthropic.Messages.MessageCreateParams = {
    model: opts.model,
    max_tokens: maxTokens,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const sys = buildSystemParam(opts.system);
  if (sys !== undefined) params.system = sys;
  const oc = buildOutputConfig(opts);
  if (oc !== undefined) {
    (params as unknown as { output_config: typeof oc }).output_config = oc;
  }
  if (opts.thinking && opts.thinking.type !== 'disabled') {
    (params as unknown as { thinking: { type: 'adaptive' } }).thinking = { type: 'adaptive' };
  }

  const startedAt = performance.now();
  // The SDK's .stream() returns a MessageStream — both async-iterable
  // for events and exposing finalMessage() for the assembled Message.
  type MessageStream = AsyncIterable<unknown> & {
    finalMessage: () => Promise<Anthropic.Messages.Message>;
    on: (event: 'text', handler: (delta: string) => void) => void;
  };
  const stream = (client.messages as { stream: (p: typeof params) => MessageStream }).stream(
    params,
  );

  async function* textStream(): AsyncIterable<string> {
    for await (const event of stream) {
      const e = event as {
        type: string;
        delta?: { type: string; text?: string };
      };
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        yield e.delta.text;
      }
    }
  }

  return {
    textStream: { [Symbol.asyncIterator]: () => textStream()[Symbol.asyncIterator]() },
    finalMessage: () =>
      breaker.execute(() => stream.finalMessage()) as Promise<Anthropic.Messages.Message>,
    startedAt,
  };
}

/**
 * Count tokens for an upcoming request without sending it. Used by the
 * orchestrator for pre-flight budget checks.
 */
export async function countTokens(
  model: ModelId,
  system: string | readonly SystemPromptSegment[] | undefined,
  messages: readonly ChatMessage[],
): Promise<number> {
  assertNotInReliabilityScope('@epagoge/ai.countTokens');
  const client = getClient();
  const params: Anthropic.Messages.MessageCountTokensParams = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const sys = buildSystemParam(system);
  if (sys !== undefined) {
    params.system = sys;
  }
  const resp = await client.messages.countTokens(params);
  return resp.input_tokens;
}
