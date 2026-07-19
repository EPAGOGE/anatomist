// Chain Explorer HTTP endpoints.
//
//   GET /chains                     — list chains the user can read
//   GET /chains/:id                 — chain head info + owner
//   GET /chains/:id/events          — paginated walk from head
//   GET /events/:hash               — single event detail
//
// All endpoints are authed via Bearer JWT. Per-chain permissions enforced
// via chain_owners (see ADR-0016 + chains/permissions.ts).
//
// The explorer is read-only — it exposes existing chain infrastructure
// as queryable HTTP. No new chain mutations happen here.

import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import { createPostgresLedger } from '@epagoge/ledger';
import { chainHeads } from '../../db/schema.js';
import { verifyToken, type JwtKey } from '../../auth/jwt.js';
import { canReadChain, listReadableChains } from '../permissions.js';

export interface ExplorerPluginOptions {
  jwtKey: JwtKey;
}

/**
 * Find the "primary head" for a chain across any source. chain_heads is
 * keyed on (chain_id, source_id); for a single-writer Phase 0 chain
 * (which all current chains are) there's one row per chain. Querying
 * without filtering by source_id avoids the trap of "user A asks for
 * platform chain Y but Y's events were written under local_user."
 */
async function getPrimaryChainHead(
  pool: pg.Pool,
  chainId: string,
): Promise<{
  headHash: string;
  headSequenceMarker: bigint;
  eventCount: bigint;
  sourceId: string;
} | null> {
  const db = drizzle(pool);
  const rows = await db
    .select()
    .from(chainHeads)
    .where(eq(chainHeads.chainId, chainId))
    .orderBy(desc(chainHeads.headSequenceMarker))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    headHash: row.headHash,
    headSequenceMarker: row.headSequenceMarker,
    eventCount: row.eventCount,
    sourceId: row.sourceId,
  };
}

function requireBearer(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  jwtKey: JwtKey,
): { userId: string; sourceId: string } | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    // Local-first: no token means the local owner (see auth/local-user.ts).
    const local = request.server.localIdentity;
    if (local) return { userId: local.userId, sourceId: local.sourceId };
    reply.code(401).send({ error: { code: 'auth-required', message: 'bearer token required' } });
    return null;
  }
  const v = verifyToken(header.slice('Bearer '.length), jwtKey, { expectType: 'access' });
  if (!v.ok) {
    reply.code(401).send({ error: { code: 'invalid-token', message: 'token rejected' } });
    return null;
  }
  return { userId: v.claims.sub, sourceId: v.claims.sid };
}

export const explorerPlugin: FastifyPluginAsync<ExplorerPluginOptions> = async (app, opts) => {
  // GET /chains — list readable
  app.get('/chains', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const chains = await listReadableChains(app.pool, auth.userId);
    const out = [];
    for (const chain of chains) {
      // Find the primary head across any source — Phase 0 chains have
      // one writer per chain so this is unambiguous.
      const head = await getPrimaryChainHead(app.pool, chain.chainId);
      out.push({
        chain_id: chain.chainId,
        owner_type: chain.ownerType,
        owner_entity_id: chain.ownerEntityId,
        head_hash: head?.headHash ?? null,
        event_count: head?.eventCount?.toString() ?? '0',
      });
    }
    return reply.send({ chains: out });
  });

  // GET /chains/:id — head info + owner
  app.get<{ Params: { id: string } }>('/chains/:id', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const verdict = await canReadChain({
      pool: app.pool,
      userId: auth.userId,
      chainId: request.params.id,
    });
    if (!verdict.allowed) {
      return reply.code(verdict.reason === 'chain-not-found' ? 404 : 403).send({
        error: { code: verdict.reason, message: `cannot read chain ${request.params.id}` },
      });
    }

    const ledger = createPostgresLedger({ pool: app.pool });
    try {
      const head = await getPrimaryChainHead(app.pool, request.params.id);
      const totalCount = await ledger.countChainEvents(request.params.id);
      return reply.send({
        chain_id: request.params.id,
        owner_type: verdict.ownerType,
        owner_entity_id: verdict.ownerEntityId,
        head_hash: head?.headHash ?? null,
        head_sequence_marker: head?.headSequenceMarker?.toString() ?? null,
        head_source_id: head?.sourceId ?? null,
        event_count_total: totalCount.toString(),
      });
    } finally {
      await ledger.close();
    }
  });

  // GET /chains/:id/events?limit=N&before_marker=M&since=<hash> — paginated walk.
  // Walks from head backwards by causal_sequence_marker. before_marker is
  // exclusive (the cursor from the previous page). When `since` is set,
  // events with marker <= that event's marker are filtered out — the
  // "what's changed since this checkpoint" pattern.
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before_marker?: string; since?: string };
  }>('/chains/:id/events', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const verdict = await canReadChain({
      pool: app.pool,
      userId: auth.userId,
      chainId: request.params.id,
    });
    if (!verdict.allowed) {
      return reply.code(verdict.reason === 'chain-not-found' ? 404 : 403).send({
        error: { code: verdict.reason, message: `cannot read chain ${request.params.id}` },
      });
    }

    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 25)));
    const beforeMarker = request.query.before_marker ? BigInt(request.query.before_marker) : null;

    const ledger = createPostgresLedger({ pool: app.pool });
    try {
      // Resolve `since` to a marker, if supplied. Events with marker <=
      // sinceMarker get filtered out below.
      let sinceMarker: bigint | null = null;
      if (request.query.since) {
        if (!/^[0-9a-f]{64}$/.test(request.query.since)) {
          return reply.code(400).send({
            error: { code: 'invalid-since', message: 'since must be a 64-char hex hash' },
          });
        }
        const sinceEvent = await ledger.getEvent(request.query.since);
        if (!sinceEvent) {
          return reply
            .code(404)
            .send({ error: { code: 'since-not-found', message: 'since event not found' } });
        }
        if (sinceEvent.chain_id !== request.params.id) {
          return reply.code(400).send({
            error: {
              code: 'since-wrong-chain',
              message: `since event lives on ${sinceEvent.chain_id}, not ${request.params.id}`,
            },
          });
        }
        sinceMarker = sinceEvent.causal_sequence_marker;
      }

      const head = await getPrimaryChainHead(app.pool, request.params.id);
      if (!head) {
        return reply.send({
          chain_id: request.params.id,
          events: [],
          next_before_marker: null,
        });
      }
      // Walk from head backwards, collecting events that satisfy both
      // pagination cursor (before_marker) and the since-checkpoint
      // (sinceMarker).
      const events = [];
      let cursor: string | null = head.headHash;
      let earliestMarker: bigint | null = null;
      while (cursor && events.length < limit) {
        const ev = await ledger.getEvent(cursor);
        if (!ev) break;
        const beforeOk = !beforeMarker || ev.causal_sequence_marker < beforeMarker;
        const sinceOk = sinceMarker === null || ev.causal_sequence_marker > sinceMarker;
        if (beforeOk && sinceOk) {
          events.push({
            event_hash: cursor,
            chain_id: ev.chain_id,
            event_type: ev.event_type,
            source_id: ev.source_id,
            causal_sequence_marker: ev.causal_sequence_marker.toString(),
            causal_predecessors: ev.causal_predecessors,
            source_reliability: ev.source_reliability,
            payload_integrity: ev.payload_integrity,
            ...(ev.ground_truth_calibration_indicator !== undefined
              ? { ground_truth_calibration_indicator: ev.ground_truth_calibration_indicator }
              : {}),
          });
          earliestMarker = ev.causal_sequence_marker;
        }
        // Early-exit on since: once the walk passes the sinceMarker, no
        // earlier event will satisfy sinceOk either.
        if (sinceMarker !== null && ev.causal_sequence_marker <= sinceMarker) break;
        cursor = ev.causal_predecessors.length > 0 ? ev.causal_predecessors[0]! : null;
      }
      return reply.send({
        chain_id: request.params.id,
        events,
        next_before_marker: earliestMarker?.toString() ?? null,
        ...(sinceMarker !== null
          ? { since_marker: sinceMarker.toString(), count_since: events.length }
          : {}),
      });
    } finally {
      await ledger.close();
    }
  });

  // GET /events/:hash — single event detail. Permission is derived from the
  // event's chain_id (whichever chain it lives on).
  app.get<{ Params: { hash: string }; Querystring: { include_payload?: string } }>(
    '/events/:hash',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const hash = request.params.hash;
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid-hash', message: 'expected 64-char lowercase hex' } });
      }

      const ledger = createPostgresLedger({ pool: app.pool });
      try {
        const event = await ledger.getEvent(hash);
        if (!event) {
          return reply.code(404).send({ error: { code: 'not-found', message: 'event not found' } });
        }
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

        const body: Record<string, unknown> = {
          event_hash: hash,
          chain_id: event.chain_id,
          event_type: event.event_type,
          source_id: event.source_id,
          version: event.version,
          causal_sequence_marker: event.causal_sequence_marker.toString(),
          causal_predecessors: event.causal_predecessors,
          source_reliability: event.source_reliability,
          payload_integrity: event.payload_integrity,
        };
        if (event.ground_truth_calibration_indicator !== undefined) {
          body.ground_truth_calibration_indicator = event.ground_truth_calibration_indicator;
        }
        if (request.query.include_payload === 'true') {
          const payload = await ledger.getEventPayload(hash);
          if (payload) {
            body.payload_size_bytes = payload.length;
            body.payload_base64 = Buffer.from(payload).toString('base64');
          }
        }
        return reply.send(body);
      } finally {
        await ledger.close();
      }
    },
  );
};
