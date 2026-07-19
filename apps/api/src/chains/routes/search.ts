// GET /chains/reasoning-capture/search?q=...&limit=N
//
// Search the reasoning-capture chain by content. Walks events, decodes
// CBOR payloads, returns those whose decision_summary or reasoning
// matches the query (case-insensitive substring). Returns event_hash +
// decision_id + summary + matched snippet.
//
// Phase 0 implementation: on-the-fly decode + linear scan. 26 ADRs makes
// this trivially fast (<10ms). When the chain reaches thousands of
// events, an indexed table per-event-type becomes worthwhile (future
// ADR). The interface stays the same.

import type { FastifyPluginAsync } from 'fastify';
import { createPostgresLedger } from '@epagoge/ledger';
import { decodeCbor, ReasoningRecordSchema } from '@epagoge/shared';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import { chainHeads } from '../../db/schema.js';
import type { JwtKey } from '../../auth/jwt.js';
import { resolveAuth } from '../../auth/local-user.js';
import { canReadChain } from '../permissions.js';

export interface SearchPluginOptions {
  jwtKey: JwtKey;
}

interface SearchHit {
  event_hash: string;
  decision_id: string;
  decision_summary: string;
  matched_in: ('summary' | 'reasoning' | 'alternatives' | 'tradeoffs')[];
  snippet: string;
  causal_sequence_marker: string;
}

const SNIPPET_PADDING = 60;

function extractSnippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx < 0)
    return text.slice(0, SNIPPET_PADDING * 2) + (text.length > SNIPPET_PADDING * 2 ? '…' : '');
  const start = Math.max(0, idx - SNIPPET_PADDING);
  const end = Math.min(text.length, idx + query.length + SNIPPET_PADDING);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

async function getReasoningHead(pool: pg.Pool): Promise<string | null> {
  const db = drizzle(pool);
  const head = (
    await db
      .select()
      .from(chainHeads)
      .where(eq(chainHeads.chainId, 'reasoning-capture'))
      .orderBy(desc(chainHeads.headSequenceMarker))
      .limit(1)
  )[0];
  return head?.headHash ?? null;
}

export const searchPlugin: FastifyPluginAsync<SearchPluginOptions> = async (app, opts) => {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/chains/reasoning-capture/search',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = resolveAuth(request, reply, opts.jwtKey);
      if (!auth) return;

      const q = (request.query.q ?? '').trim();
      if (q.length < 2) {
        return reply.code(400).send({
          error: {
            code: 'invalid-query',
            message: 'query must be at least 2 characters',
          },
        });
      }
      const limit = Math.min(50, Math.max(1, Number(request.query.limit ?? 10)));

      // Permission check on the reasoning-capture chain (platform-owned;
      // any authed user can read).
      const verdict = await canReadChain({
        pool: app.pool,
        userId: auth.userId,
        chainId: 'reasoning-capture',
      });
      if (!verdict.allowed) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'cannot read reasoning-capture chain' },
        });
      }

      const ledger = createPostgresLedger({ pool: app.pool });
      try {
        const headHash = await getReasoningHead(app.pool);
        if (!headHash) {
          return reply.send({ query: q, hits: [], total_walked: 0 });
        }

        // Walk head → genesis; for each event, decode the payload, check
        // against the query, collect matches.
        const hits: SearchHit[] = [];
        let cursor: string | null = headHash;
        let walked = 0;
        const qLower = q.toLowerCase();

        while (cursor && hits.length < limit) {
          walked++;
          const event = await ledger.getEvent(cursor);
          if (!event) break;
          const payload = await ledger.getEventPayload(cursor);
          if (payload) {
            try {
              const decoded = decodeCbor<unknown>(payload);
              const parsed = ReasoningRecordSchema.safeParse(decoded);
              if (parsed.success) {
                const rec = parsed.data;
                const matched: SearchHit['matched_in'] = [];
                if (rec.decision_summary.toLowerCase().includes(qLower)) matched.push('summary');
                if (rec.reasoning.toLowerCase().includes(qLower)) matched.push('reasoning');
                if (rec.alternatives_considered.some((a) => a.toLowerCase().includes(qLower))) {
                  matched.push('alternatives');
                }
                if (rec.trade_offs_weighed.some((t) => t.toLowerCase().includes(qLower))) {
                  matched.push('tradeoffs');
                }
                if (matched.length > 0) {
                  // Pick the longest matching field for the snippet.
                  const candidates: Record<string, string> = {
                    summary: rec.decision_summary,
                    reasoning: rec.reasoning,
                    alternatives:
                      rec.alternatives_considered.find((a) => a.toLowerCase().includes(qLower)) ??
                      '',
                    tradeoffs:
                      rec.trade_offs_weighed.find((t) => t.toLowerCase().includes(qLower)) ?? '',
                  };
                  const snippetSource = matched
                    .map((m) => candidates[m] ?? '')
                    .reduce((a, b) => (b.length > a.length ? b : a), '');
                  hits.push({
                    event_hash: cursor,
                    decision_id: rec.decision_id,
                    decision_summary: rec.decision_summary,
                    matched_in: matched,
                    snippet: extractSnippet(snippetSource, q),
                    causal_sequence_marker: event.causal_sequence_marker.toString(),
                  });
                }
              }
            } catch {
              // Non-ReasoningRecord payload; skip silently.
            }
          }
          cursor = event.causal_predecessors.length > 0 ? event.causal_predecessors[0]! : null;
        }

        return reply.send({
          query: q,
          hits,
          total_walked: walked,
          has_more: cursor !== null && hits.length === limit,
        });
      } finally {
        await ledger.close();
      }
    },
  );
};
