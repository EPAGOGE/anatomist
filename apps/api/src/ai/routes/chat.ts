import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createPostgresLedger } from '@epagoge/ledger';
import { resolveReferences, formatReferencesForPrompt } from '@epagoge/ai';
import { invokeAi, BudgetExceededError } from '../orchestrator.js';
import { AI_PURPOSES } from '@epagoge/shared';
import type { JwtKey } from '../../auth/jwt.js';
import type { LocalIdentity } from '../../identity/local-key-store.js';
import { resolveAuth } from '../../auth/local-user.js';

const ChatBodySchema = z.object({
  /** What the platform is using AI for. */
  purpose: z.enum(AI_PURPOSES).default('chat'),
  /** Optional system prompt. Caller controls the voice. */
  system: z.string().max(100_000).optional(),
  /** Conversation history (alternating user/assistant; first must be user). */
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(200_000),
      }),
    )
    .min(1)
    .max(50),
  /** Optional explicit tier override. */
  tier: z.enum(['haiku', 'sonnet', 'opus']).optional(),
  /** Whether the caller wants adaptive thinking. */
  thinking: z.boolean().default(false),
  /** Optional project association for cost attribution. */
  project_id: z.string().uuid().optional(),
  /** Free-form feature label. */
  feature: z.string().max(128).optional(),
});

export interface ChatPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

export const chatPlugin: FastifyPluginAsync<ChatPluginOptions> = async (app, opts) => {
  app.post('/ai/chat', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }

    const auth = resolveAuth(request, reply, opts.jwtKey);
    if (!auth) return;

    const parsed = ChatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid chat body',
          details: parsed.error.flatten(),
        },
      });
    }

    // F-0 Criterion 5 (per ADR-0037): resolve references — project
    // context, recent decisions, recent chain history — and prepend
    // them as a system-prompt segment. The resolver does its own
    // selectivity (recency + cheap relevance, capped per section)
    // so we don't blow up tokens; if the user has no active project
    // the loaders return null/empty and no grounding is added.
    const lastUserMessage = [...parsed.data.messages].reverse().find((m) => m.role === 'user');
    const queryText = lastUserMessage?.content ?? '';
    const refLedger = createPostgresLedger({ pool: app.pool });
    let groundingSegment = '';
    try {
      const refs = await resolveReferences({
        userId: auth.userId,
        projectId: parsed.data.project_id ?? null,
        sessionId: auth.sourceId, // per-source session for F-0 (multi-turn persistence is Phase 1)
        query: queryText,
        pool: app.pool,
        ledger: refLedger,
      });
      groundingSegment = formatReferencesForPrompt(refs);
    } catch (err) {
      // Grounding failure must NOT block the chat — the AI should still
      // respond, just without project context. Log and continue.
      app.log.warn(
        { err, userId: auth.userId },
        'reference resolution failed; continuing ungrounded',
      );
    } finally {
      await refLedger.close();
    }

    // Compose the system prompt: caller-provided base + grounding
    // segment. The discipline substrate (ADR-0026) gets prepended
    // separately inside invokeAi when applyDiscipline:true.
    const composedSystem = [parsed.data.system ?? '', groundingSegment]
      .filter((s) => s.trim().length > 0)
      .join('\n\n')
      .trim();

    try {
      const result = await invokeAi({
        pool: app.pool,
        platformIdentity: opts.platformIdentity,
        userId: auth.userId,
        sourceId: auth.sourceId,
        purpose: parsed.data.purpose,
        ...(composedSystem ? { system: composedSystem } : {}),
        messages: parsed.data.messages,
        routing: {
          ...(parsed.data.tier ? { forceTier: parsed.data.tier } : {}),
          thinkingMode: parsed.data.thinking ? 'adaptive' : 'disabled',
        },
        ...(parsed.data.project_id ? { projectId: parsed.data.project_id } : {}),
        ...(parsed.data.feature ? { feature: parsed.data.feature } : {}),
      });

      // verdict.spentNanos is the PRE-call current spend; the actual
      // post-call spend is verdict.spentNanos + result.costNanos. Report
      // post-call values to the caller so the UI shows what actually
      // happened, not what would have happened in the worst case.
      const verdict = result.budgetVerdict;
      const postCallSpent =
        verdict.kind === 'block' ? verdict.spentNanos : verdict.spentNanos + result.costNanos;
      const postCallRemaining = verdict.kind === 'block' ? 0n : verdict.capNanos - postCallSpent;

      if (verdict.kind !== 'allow') {
        reply.header('x-epagoge-budget-state', verdict.kind);
      }
      if (verdict.kind === 'warn' || verdict.kind === 'allow') {
        reply.header('x-epagoge-budget-spent-nanos', postCallSpent.toString());
        reply.header('x-epagoge-budget-cap-nanos', verdict.capNanos.toString());
      }

      return reply.send({
        interaction_id: result.interactionId,
        chain_event_hash: result.chainEventHash,
        text: result.text,
        model: result.model,
        tier: result.tier,
        cost_nanos: result.costNanos.toString(),
        from_cache: result.fromCache,
        tokens: result.tokens,
        finish_reason: result.finishReason,
        budget: {
          state: verdict.kind,
          spent_nanos: postCallSpent.toString(),
          cap_nanos: verdict.capNanos.toString(),
          ...(verdict.kind !== 'block' ? { remaining_nanos: postCallRemaining.toString() } : {}),
        },
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return reply.code(402).send({
          error: {
            code: 'budget-exceeded',
            message: 'monthly AI budget exceeded',
            details: {
              spent_nanos: err.spentNanos.toString(),
              cap_nanos: err.capNanos.toString(),
            },
          },
        });
      }
      app.log.error({ err }, 'invokeAi failed');
      return reply.code(502).send({
        error: { code: 'ai-failure', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
};
