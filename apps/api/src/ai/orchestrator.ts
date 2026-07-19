// AI orchestrator. The single entry point HTTP routes and background
// jobs use to invoke AI.
//
// Steps per invocation:
//   1. ADR-0008 runtime-guard check (refuse if on reliability path).
//   2. Routing decision (model + effort + thinking) via @epagoge/ai router.
//   3. Pre-flight token count + budget check.
//   4. Deterministic-response cache lookup.
//   5. Anthropic call via @epagoge/ai client (createMessage / streamMessage).
//   6. Cost computation from Anthropic usage figures.
//   7. ai_interactions row insert.
//   8. ai-interaction chain event append.
//   9. Budget debit.
//
// The orchestrator does NOT decide what content to put in the prompt —
// callers assemble system/messages from their own context-selection
// logic (the recency+relevance pattern in ADR-0023). The orchestrator
// is the safety + accounting + provenance layer around any prompt.

import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { blake3 } from '@epagoge/crypto';
import {
  route,
  createMessage,
  computeCost,
  computeCacheKey,
  isCacheable,
  PLATFORM_PHILOSOPHY,
  classifyResponse,
  estimateQueryComplexity,
  preFlightCheck as disciplinePreFlight,
  ROUTINE_RHYTHM,
  SUBSTANTIAL_RHYTHM,
  HERO_RHYTHM,
  formatRhythmGuidance,
  type ChatMessage,
  type SystemPromptSegment,
  type RoutingInput,
  type ModelId,
  type ResponseType,
  type RhythmProfile,
  type QualityCheckResult,
} from '@epagoge/ai';
import {
  AI_PURPOSES,
  type AiInteractionEventPayload,
  type AiInteractionDetails,
} from '@epagoge/shared';
import { aiInteractions, aiResponseCache } from '../db/schema.js';
import { preFlightCheck, debit, type BudgetVerdict } from './budget.js';
import { appendAiInteractionWithPool } from './ai-events.js';
import type { LocalIdentity } from '../identity/local-key-store.js';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hashUtf8(s: string): string {
  return bytesToHex(blake3.hash(new TextEncoder().encode(s)));
}

function canonicalPromptHash(
  system: string | readonly SystemPromptSegment[] | undefined,
  messages: readonly ChatMessage[],
): string {
  const sys = typeof system === 'string' ? system : (system ?? []).map((s) => s.text).join('\n');
  return hashUtf8(JSON.stringify({ sys, m: messages.map((m) => [m.role, m.content]) }));
}

export interface InvokeAiOptions {
  pool: pg.Pool;
  platformIdentity: LocalIdentity;
  /** Initiator. user_id is for HTTP-registered users; source_id is the
   *  chain source. Background jobs pass source_id only. */
  userId?: string;
  sourceId: string;
  /** Why the platform is using AI. */
  purpose: (typeof AI_PURPOSES)[number];
  /** Optional project association. */
  projectId?: string;
  /** Free-form feature label (e.g. 'composer-suggest', 'chain-summarize'). */
  feature?: string;
  /** System prompt — string for simple cases, segments for caching. */
  system?: string | readonly SystemPromptSegment[];
  /** Conversation. */
  messages: readonly ChatMessage[];
  /** Routing hints (the router decides; these are heuristic inputs). */
  routing?: Partial<RoutingInput>;
  /** Maximum nanos this call is allowed to cost. Defaults to a conservative
   *  per-call cap; budget check still applies on top. */
  maxNanosPerCall?: bigint;
  /** Optional system-prompt template id for catalog-tracked prompts. */
  systemPromptId?: string;
  /** Context-selection metadata for the chain event. */
  contextSelection?: AiInteractionDetails['context_selection'];
  /**
   * Opt in to the production-discipline layer (ADR-0026):
   *   - prepends PLATFORM_PHILOSOPHY + rhythm guidance to the system prompt
   *   - runs preFlightCheck against the response
   *   - retries once on revise/regenerate with a feedback turn
   *
   * Default false to preserve existing call-site behavior. New callers
   * should set this true.
   */
  applyDiscipline?: boolean;
  /** Hints that drive response-type classification when discipline is on. */
  disciplineHints?: {
    isFirstInteraction?: boolean;
    isFirstProjectMessage?: boolean;
    projectStage?: string | null;
    sessionLength?: number;
  };
}

export interface InvokeAiResult {
  /** The interaction id (matches ai_interactions.id and chain event details.interaction_id). */
  interactionId: string;
  /** The chain event hash this interaction was recorded under. */
  chainEventHash: string;
  /** Final response text (concatenated text blocks). */
  text: string;
  /** Routing decision actually used. */
  model: ModelId;
  tier: 'haiku' | 'sonnet' | 'opus';
  /** Cost in nano-USD. */
  costNanos: bigint;
  /** Budget verdict at pre-flight (post-call spend reflects this call). */
  budgetVerdict: BudgetVerdict;
  /** True if served from local deterministic cache. */
  fromCache: boolean;
  /** Token usage. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Anthropic stop_reason for the call. */
  finishReason?: string;
  /** Discipline classification + preflight verdict, populated when
   *  applyDiscipline was on. Absent on calls that didn't opt in. */
  discipline?: {
    responseType: ResponseType;
    preflightRecommendation: 'send' | 'revise' | 'regenerate';
    retryCount: number;
    preflightIssueCount: number;
  };
}

export const DEFAULT_MAX_NANOS_PER_CALL = 500_000_000n; // $0.50

/**
 * Invoke AI through the full safety + accounting + provenance pipeline.
 * One call → one row in ai_interactions, one event on ai-interaction chain.
 */
export async function invokeAi(opts: InvokeAiOptions): Promise<InvokeAiResult> {
  const interactionId = randomUUID();
  const startedAt = performance.now();

  // 0. Discipline classification (ADR-0026). When applyDiscipline is on,
  //    classify the response BEFORE routing so the discipline + routing
  //    decisions are coherent. When off, downstream behavior is unchanged.
  const lastUserMessage = [...opts.messages].reverse().find((m) => m.role === 'user');
  const userQueryText = lastUserMessage?.content ?? '';
  let responseType: ResponseType | null = null;
  let rhythmProfile: RhythmProfile | null = null;
  if (opts.applyDiscipline) {
    responseType = classifyResponse({
      query: userQueryText,
      isFirstInteraction: opts.disciplineHints?.isFirstInteraction ?? false,
      isFirstProjectMessage: opts.disciplineHints?.isFirstProjectMessage ?? false,
      projectStage: opts.disciplineHints?.projectStage ?? null,
      sessionLength: opts.disciplineHints?.sessionLength ?? 0,
      queryComplexity: estimateQueryComplexity(userQueryText),
    });
    rhythmProfile =
      responseType === 'hero'
        ? HERO_RHYTHM
        : responseType === 'substantial'
          ? SUBSTANTIAL_RHYTHM
          : ROUTINE_RHYTHM;
  }

  // Build the effective system prompt. When discipline is on, the
  // PLATFORM_PHILOSOPHY sits at the front (stable across all calls — the
  // declared voice), followed by rhythm guidance matched to the response
  // type, then the caller-supplied system content.
  //
  // The philosophy + rhythm together sit under the cache-control
  // breakpoint pattern from ADR-0022; the caller's task-specific content
  // sits after, where it can vary per call without invalidating the
  // stable prefix.
  const effectiveSystem: string | readonly SystemPromptSegment[] | undefined =
    opts.applyDiscipline && rhythmProfile
      ? buildDisciplineSystemPrompt(rhythmProfile, opts.system)
      : opts.system;

  // 1. Routing decision.
  const inputChars =
    (effectiveSystem ? estimateChars(effectiveSystem) : 0) +
    opts.messages.reduce((s, m) => s + m.content.length, 0);
  const decision = route({
    purpose: opts.purpose,
    inputChars,
    ...(opts.routing ?? {}),
    // When discipline is on, the response type can influence routing:
    // hero moments earn opus regardless of length signals.
    ...(responseType === 'hero' ? { forceTier: 'opus' as const } : {}),
    ...(responseType === 'substantial' && !opts.routing?.forceTier ? { needsReasoning: true } : {}),
  });

  // 2. Pre-flight budget check. For now we estimate an upper bound; the
  //    actual cost is debited after the call.
  const estimatedNanos = opts.maxNanosPerCall ?? DEFAULT_MAX_NANOS_PER_CALL;
  let verdict: BudgetVerdict;
  if (opts.userId) {
    verdict = await preFlightCheck(opts.pool, opts.userId, estimatedNanos);
    if (verdict.kind === 'block') {
      throw new BudgetExceededError(verdict.spentNanos, verdict.capNanos);
    }
  } else {
    // Background jobs without a user are platform overhead; no budget gate.
    verdict = {
      kind: 'allow',
      remainingNanos: 0n,
      capNanos: 0n,
      spentNanos: 0n,
    };
  }

  const promptHash = canonicalPromptHash(effectiveSystem, opts.messages);
  const cacheable = isCacheable({ effort: decision.effort, thinking: decision.thinking });

  // 3. Deterministic-cache lookup.
  let fromCache = false;
  let text: string;
  let usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  let finishReason: string | undefined;
  let anthropicRequestId: string | undefined;

  // Track discipline preflight outcome + retry count for chain capture.
  let preflightResult: QualityCheckResult | null = null;
  let retryCount = 0;

  if (cacheable && decision.thinking.type === 'disabled') {
    const cacheKey = computeCacheKey({
      model: decision.model,
      system: effectiveSystem,
      messages: opts.messages,
      effort: decision.effort,
      thinking: { type: 'disabled' },
    });
    const cached = await fetchResponseCache(opts.pool, cacheKey);
    if (cached) {
      fromCache = true;
      text = cached.responseText;
      usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: cached.inputTokens,
        cache_creation_input_tokens: 0,
      };
      await touchResponseCache(opts.pool, cacheKey);
    } else {
      const fresh = await callAnthropicWithSystem(
        effectiveSystem,
        opts.messages,
        decision.model,
        decision.effort,
        decision.thinking,
      );
      text = fresh.text;
      usage = fresh.usage;
      finishReason = fresh.finishReason;
      anthropicRequestId = fresh.requestId;
      await storeResponseCache(opts.pool, cacheKey, decision.model, text, usage);
    }
  } else {
    const fresh = await callAnthropicWithSystem(
      effectiveSystem,
      opts.messages,
      decision.model,
      decision.effort,
      decision.thinking,
    );
    text = fresh.text;
    usage = fresh.usage;
    finishReason = fresh.finishReason;
    anthropicRequestId = fresh.requestId;
  }

  // 3.5. Discipline preflight + retry loop (ADR-0026). Only when
  //      applyDiscipline is on AND the response wasn't served from
  //      cache (cached responses have already been preflighted at
  //      their original emission).
  if (opts.applyDiscipline && responseType && !fromCache) {
    preflightResult = disciplinePreFlight({
      query: userQueryText,
      draftResponse: text,
      responseType,
    });
    if (preflightResult.recommendation !== 'send') {
      // Retry once with a feedback turn appended. The feedback names the
      // issues so the model can produce a targeted revision.
      const feedback = buildPreflightFeedback(preflightResult);
      const retryMessages: ChatMessage[] = [
        ...opts.messages,
        { role: 'assistant', content: text },
        { role: 'user', content: feedback },
      ];
      const retry = await callAnthropicWithSystem(
        effectiveSystem,
        retryMessages,
        decision.model,
        decision.effort,
        decision.thinking,
      );
      // Merge token usage — the platform pays for both the initial draft
      // AND the retry, and the chain event must reflect the true cost.
      text = retry.text;
      usage = {
        input_tokens: usage.input_tokens + retry.usage.input_tokens,
        output_tokens: usage.output_tokens + retry.usage.output_tokens,
        ...(usage.cache_read_input_tokens !== undefined ||
        retry.usage.cache_read_input_tokens !== undefined
          ? {
              cache_read_input_tokens:
                (usage.cache_read_input_tokens ?? 0) + (retry.usage.cache_read_input_tokens ?? 0),
            }
          : {}),
        ...(usage.cache_creation_input_tokens !== undefined ||
        retry.usage.cache_creation_input_tokens !== undefined
          ? {
              cache_creation_input_tokens:
                (usage.cache_creation_input_tokens ?? 0) +
                (retry.usage.cache_creation_input_tokens ?? 0),
            }
          : {}),
      };
      finishReason = retry.finishReason ?? finishReason;
      retryCount = 1;
      // Re-run preflight on the retry to surface whether it improved.
      // Even if the second draft still has issues, we send it — the chain
      // event captures the verdict so analytics can see persistent
      // anti-patterns from a particular model + prompt combination.
      preflightResult = disciplinePreFlight({
        query: userQueryText,
        draftResponse: text,
        responseType,
      });
    }
  }

  // 4. Cost computation.
  const cost = computeCost(decision.model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
  });

  const durationMs = Math.round(performance.now() - startedAt);
  const occurredAt = new Date();

  // 5. Build the chain event payload.
  const details: AiInteractionDetails = {
    interaction_id: interactionId,
    source_id: opts.sourceId,
    purpose: opts.purpose,
    model: decision.model,
    tier: decision.tier,
    cache_hit_local: fromCache,
    cache_hit_prompt: (usage.cache_read_input_tokens ?? 0) > 0,
    tokens: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens ?? 0,
      cache_write: usage.cache_creation_input_tokens ?? 0,
    },
    cost: {
      input_nanos: cost.inputNanos,
      output_nanos: cost.outputNanos,
      cache_read_nanos: cost.cacheReadNanos,
      cache_write_nanos: cost.cacheWriteNanos,
      total_nanos: cost.totalNanos,
    },
    duration_ms: durationMs,
    prompt_hash: promptHash,
    response_hash: hashUtf8(text),
    occurred_at: occurredAt.toISOString(),
  };
  if (opts.userId) details.user_id = opts.userId;
  if (opts.projectId) details.project_id = opts.projectId;
  if (opts.feature) details.feature = opts.feature;
  if (anthropicRequestId) details.request_id = anthropicRequestId;
  if (finishReason && isKnownFinishReason(finishReason)) details.finish_reason = finishReason;
  if (opts.systemPromptId) details.system_prompt_id = opts.systemPromptId;
  if (opts.contextSelection) details.context_selection = opts.contextSelection;

  const payload: AiInteractionEventPayload = { kind: 'ai-interaction', details };

  // 6. Append to chain (best-effort: chain append failure does not block
  //    the response, but does block the DB row to keep them in sync).
  let chainEventHash: string;
  try {
    chainEventHash = await appendAiInteractionWithPool(opts.pool, opts.platformIdentity, payload);
  } catch (err) {
    // Surface as an explicit error class — caller may want to retry the
    // chain append asynchronously rather than fail the whole request.
    throw new ChainEmissionFailedError(err instanceof Error ? err.message : String(err));
  }

  // 7. ai_interactions row insert (after chain append so chain_event_hash is non-null).
  const db = drizzle(opts.pool);
  await db.insert(aiInteractions).values({
    id: interactionId,
    userId: opts.userId ?? null,
    sourceId: opts.sourceId,
    purpose: opts.purpose,
    projectId: opts.projectId ?? null,
    feature: opts.feature ?? null,
    model: decision.model,
    tier: decision.tier,
    cacheHitLocal: fromCache,
    cacheHitPrompt: (usage.cache_read_input_tokens ?? 0) > 0,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costInputNanos: cost.inputNanos,
    costOutputNanos: cost.outputNanos,
    costCacheReadNanos: cost.cacheReadNanos,
    costCacheWriteNanos: cost.cacheWriteNanos,
    costTotalNanos: cost.totalNanos,
    durationMs,
    finishReason: finishReason ?? null,
    requestId: anthropicRequestId ?? null,
    promptHash,
    responseHash: details.response_hash,
    systemPromptId: opts.systemPromptId ?? null,
    contextSelectionJson: opts.contextSelection ? JSON.stringify(opts.contextSelection) : null,
    chainEventHash,
    occurredAt,
  });

  // 8. Debit budget.
  if (opts.userId && cost.totalNanos > 0n) {
    await debit(opts.pool, opts.userId, cost.totalNanos);
  }

  return {
    interactionId,
    chainEventHash,
    text,
    model: decision.model,
    tier: decision.tier,
    costNanos: cost.totalNanos,
    budgetVerdict: verdict,
    fromCache,
    tokens: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
    ...(finishReason ? { finishReason } : {}),
    ...(opts.applyDiscipline && responseType && preflightResult
      ? {
          discipline: {
            responseType,
            preflightRecommendation: preflightResult.recommendation,
            retryCount,
            preflightIssueCount: preflightResult.issues.length,
          },
        }
      : {}),
  };
}

/**
 * Compose the discipline-aware system prompt: PLATFORM_PHILOSOPHY first
 * (declared voice; stable across all calls), rhythm guidance next
 * (response-type-specific structural hints), then the caller's
 * task-specific system content. The split keeps the stable prefix
 * cache-friendly per ADR-0022 — once chained with future catalog content
 * large enough to clear the cache-prefix-minimum threshold, the
 * platform-philosophy segment becomes a cache breakpoint.
 */
function buildDisciplineSystemPrompt(
  rhythm: RhythmProfile,
  callerSystem: string | readonly SystemPromptSegment[] | undefined,
): readonly SystemPromptSegment[] {
  const segments: SystemPromptSegment[] = [
    { text: PLATFORM_PHILOSOPHY },
    { text: formatRhythmGuidance(rhythm) },
  ];
  if (callerSystem) {
    if (typeof callerSystem === 'string') {
      segments.push({ text: callerSystem });
    } else {
      segments.push(...callerSystem);
    }
  }
  return segments;
}

/**
 * Build a feedback turn telling the model exactly what to fix. The
 * feedback names anti-patterns + substance issues by description so the
 * model can target the revision rather than starting from scratch.
 */
function buildPreflightFeedback(result: QualityCheckResult): string {
  const bullets = result.issues.map((i) => `- [${i.severity}] ${i.description}`);
  return (
    `Your previous response had quality issues:\n\n${bullets.join('\n')}\n\n` +
    `Revise the response to address these issues. Do not acknowledge this ` +
    `feedback in the revised response — just produce the better version. ` +
    `Keep what was good; fix what was flagged.`
  );
}

interface CallResult {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  finishReason?: string;
  requestId?: string;
}

async function callAnthropicWithSystem(
  system: string | readonly SystemPromptSegment[] | undefined,
  messages: readonly ChatMessage[],
  model: ModelId,
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  thinking: { type: 'adaptive' } | { type: 'disabled' },
): Promise<CallResult> {
  const { message } = await createMessage({
    model,
    ...(system !== undefined ? { system } : {}),
    messages,
    effort,
    thinking,
  });
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return {
    text,
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      ...(message.usage.cache_read_input_tokens !== undefined &&
      message.usage.cache_read_input_tokens !== null
        ? { cache_read_input_tokens: message.usage.cache_read_input_tokens }
        : {}),
      ...(message.usage.cache_creation_input_tokens !== undefined &&
      message.usage.cache_creation_input_tokens !== null
        ? { cache_creation_input_tokens: message.usage.cache_creation_input_tokens }
        : {}),
    },
    ...(message.stop_reason ? { finishReason: message.stop_reason } : {}),
    ...(message.id ? { requestId: message.id } : {}),
  };
}

async function fetchResponseCache(
  pool: pg.Pool,
  cacheKey: string,
): Promise<{ responseText: string; inputTokens: number; outputTokens: number } | null> {
  const db = drizzle(pool);
  const row = (
    await db
      .select()
      .from(aiResponseCache)
      .where(and(eq(aiResponseCache.cacheKey, cacheKey), sql`expires_at > now()`))
      .limit(1)
  )[0];
  if (!row) return null;
  return {
    responseText: row.responseText,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

async function touchResponseCache(pool: pg.Pool, cacheKey: string): Promise<void> {
  const db = drizzle(pool);
  await db
    .update(aiResponseCache)
    .set({ hitCount: sql`${aiResponseCache.hitCount} + 1`, lastHitAt: sql`now()` })
    .where(eq(aiResponseCache.cacheKey, cacheKey));
}

async function storeResponseCache(
  pool: pg.Pool,
  cacheKey: string,
  model: ModelId,
  responseText: string,
  usage: { input_tokens: number; output_tokens: number },
): Promise<void> {
  const db = drizzle(pool);
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  await db
    .insert(aiResponseCache)
    .values({
      cacheKey,
      model,
      responseText,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      expiresAt: oneHourFromNow,
    })
    .onConflictDoNothing();
}

function estimateChars(system: string | readonly SystemPromptSegment[]): number {
  if (typeof system === 'string') return system.length;
  return system.reduce((s, seg) => s + seg.text.length, 0);
}

function isKnownFinishReason(
  r: string,
): r is 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' {
  return (
    r === 'end_turn' ||
    r === 'max_tokens' ||
    r === 'stop_sequence' ||
    r === 'tool_use' ||
    r === 'pause_turn' ||
    r === 'refusal'
  );
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentNanos: bigint,
    public readonly capNanos: bigint,
  ) {
    super(`budget exceeded: $${Number(spentNanos) / 1e9} of $${Number(capNanos) / 1e9} spent`);
    this.name = 'BudgetExceededError';
  }
}

export class ChainEmissionFailedError extends Error {
  constructor(detail: string) {
    super(`ai-interaction chain emission failed: ${detail}`);
    this.name = 'ChainEmissionFailedError';
  }
}
