// POST /events/:hash/explain
//
// Given a chain event hash, decode its payload, send it through the AI
// orchestrator with a system prompt designed to produce plain-English
// description, and return the explanation alongside a chain-event hash
// for the explanation itself (every AI call produces an ai-interaction
// event per ADR-0025).
//
// This is the canonical demonstration of "AI + chains composed." The
// chains hold the signed truth; the AI layer makes it human-readable.
// The compose is one HTTP call. Per-chain read permissions enforced via
// the same helpers as the explorer.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createPostgresLedger } from '@epagoge/ledger';
import { decodeCbor } from '@epagoge/shared';
import type { JwtKey } from '../../auth/jwt.js';
import { canReadChain } from '../permissions.js';
import { invokeAi } from '../../ai/orchestrator.js';
import type { LocalIdentity } from '../../identity/local-key-store.js';
import { resolveAuth } from '../../auth/local-user.js';

const BodySchema = z
  .object({
    /** Optional tier override; default lets the router decide. */
    tier: z.enum(['haiku', 'sonnet', 'opus']).optional(),
    /** Include the raw decoded payload in the response (for debugging). */
    include_decoded: z.boolean().optional(),
  })
  .optional();

const EXPLAIN_SYSTEM_PROMPT = `
You are explaining a single signed event from the EPAGOGE platform's
cryptographic provenance chain. Each event records something the platform
or its users did — a decision, an AI interaction, an auth event, a system
lifecycle moment — and carries hybrid (post-quantum + classical) signatures
so its content can be verified after the fact.

Your job: given the structured payload of one event, explain in plain
English:
  1. What kind of event this is.
  2. What it recorded (who did what, when, with what outcome).
  3. Why it matters — what downstream use this event enables (audit,
     replay, decision history, cost accounting, etc.).

Be concise. Three to six sentences typically. Do not invent details that
aren't in the payload. If a field's meaning isn't obvious from its name
and value, say so rather than guess. When the event references other
events by hash (causal_predecessors, context_selection.included_chain_events),
mention those references but don't speculate about their contents.

Return prose only — no JSON, no markdown headers, no bullet lists unless
the payload is structurally a list of items.
`.trim();

export interface ExplainPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

export const explainPlugin: FastifyPluginAsync<ExplainPluginOptions> = async (app, opts) => {
  app.post<{
    Params: { hash: string };
    Body: z.infer<typeof BodySchema>;
  }>('/events/:hash/explain', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }

    // Auth.
    const auth = resolveAuth(request, reply, opts.jwtKey);
    if (!auth) return;

    // Validate hash.
    const hash = request.params.hash;
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid-hash', message: 'expected 64-char lowercase hex' } });
    }

    const body = BodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'invalid-request', message: 'invalid body' } });
    }

    const ledger = createPostgresLedger({ pool: app.pool });
    try {
      const event = await ledger.getEvent(hash);
      if (!event) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'event not found' } });
      }

      // Permission check via the event's chain.
      const verdict = await canReadChain({
        pool: app.pool,
        userId: auth.userId,
        chainId: event.chain_id,
      });
      if (!verdict.allowed) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: `cannot read events on chain ${event.chain_id}` },
        });
      }

      // Decode the payload to give the model structural content rather
      // than just a hex hash. Payloads ≤ 10 KiB are inline; larger live in
      // the blob store (see ADR-0014). getEventPayload abstracts both.
      const payload = await ledger.getEventPayload(hash);
      if (!payload) {
        return reply.code(422).send({
          error: {
            code: 'payload-unavailable',
            message: 'event has no inline payload and blob storage returned nothing',
          },
        });
      }

      let decoded: unknown;
      try {
        decoded = decodeCbor(payload);
      } catch (err) {
        return reply.code(500).send({
          error: {
            code: 'payload-decode-failed',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }

      // Build the prompt. The event's structural metadata + the decoded
      // payload together give the model what it needs.
      const promptContent = [
        `EVENT HEADER:`,
        `  hash: ${hash}`,
        `  chain_id: ${event.chain_id}`,
        `  event_type: ${event.event_type}`,
        `  source_id: ${event.source_id}`,
        `  causal_sequence_marker: ${event.causal_sequence_marker}`,
        `  causal_predecessors: ${
          event.causal_predecessors.length === 0
            ? '[] (genesis)'
            : event.causal_predecessors.map((h) => h.slice(0, 12) + '…').join(', ')
        }`,
        ``,
        `PAYLOAD (decoded from canonical CBOR):`,
        JSON.stringify(decoded, jsonReplacer, 2),
      ].join('\n');

      const result = await invokeAi({
        pool: app.pool,
        platformIdentity: opts.platformIdentity,
        userId: auth.userId,
        sourceId: auth.sourceId,
        purpose: 'background-analysis',
        feature: 'chain-event-explain',
        system: EXPLAIN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: promptContent }],
        ...(body.data?.tier ? { routing: { forceTier: body.data.tier } } : {}),
        applyDiscipline: true,
        // The explanation IS a derivation referencing this event. Capture
        // the source-event hash in context_selection per ADR-0023.
        contextSelection: {
          strategy: 'chain-event-explain-v1',
          included_chain_events: [hash],
        },
      });

      return reply.send({
        source_event_hash: hash,
        source_chain_id: event.chain_id,
        explanation: result.text,
        ai_interaction: {
          interaction_id: result.interactionId,
          chain_event_hash: result.chainEventHash,
          model: result.model,
          tier: result.tier,
          cost_nanos: result.costNanos.toString(),
          from_cache: result.fromCache,
          tokens: result.tokens,
          ...(result.discipline ? { discipline: result.discipline } : {}),
        },
        ...(body.data?.include_decoded ? { decoded_payload: decoded } : {}),
      });
    } finally {
      await ledger.close();
    }
  });
};

/** JSON.stringify replacer that handles BigInt + Uint8Array. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) {
    return `<bytes:${value.length}:${Buffer.from(value).toString('hex').slice(0, 16)}...>`;
  }
  return value;
}
