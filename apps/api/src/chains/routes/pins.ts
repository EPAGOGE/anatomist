// Chain pinning + diff endpoints.
//
//   POST   /chains/:id/pins                  — pin an event hash on a chain
//   GET    /chains/:id/pins                  — list this user's pins on chain
//   DELETE /chains/:id/pins/:pin_id          — remove a pin
//   GET    /chains/:id/events?since=<hash>   — events with marker greater
//                                               than the pinned event's marker
//
// Pins are user-scoped soft anchors. They don't modify the chain itself —
// the chain stays append-only and cryptographically valid regardless of
// whether anyone has pinned an event on it. Pins enable the "what's
// changed since I last checked" pattern that maps cleanly to the
// append-only structure: any event with a higher causal_sequence_marker
// than the pinned event is, by definition, work that happened after.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { createPostgresLedger } from '@epagoge/ledger';
import { chainPins } from '../../db/schema.js';
import { verifyToken, type JwtKey } from '../../auth/jwt.js';
import { canReadChain } from '../permissions.js';

const PinBodySchema = z.object({
  event_hash: z.string().regex(/^[0-9a-f]{64}$/),
  label: z.string().min(1).max(128).optional(),
});

export interface PinsPluginOptions {
  jwtKey: JwtKey;
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

export const pinsPlugin: FastifyPluginAsync<PinsPluginOptions> = async (app, opts) => {
  // POST /chains/:id/pins — pin an event.
  app.post<{ Params: { id: string }; Body: z.infer<typeof PinBodySchema> }>(
    '/chains/:id/pins',
    async (request, reply) => {
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
          error: { code: verdict.reason, message: `cannot pin on chain ${request.params.id}` },
        });
      }

      const parsed = PinBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'invalid-request',
            message: 'invalid pin body',
            details: parsed.error.flatten(),
          },
        });
      }

      // Validate the event actually exists on this chain.
      const ledger = createPostgresLedger({ pool: app.pool });
      try {
        const event = await ledger.getEvent(parsed.data.event_hash);
        if (!event) {
          return reply
            .code(404)
            .send({ error: { code: 'event-not-found', message: 'no such event' } });
        }
        if (event.chain_id !== request.params.id) {
          return reply.code(400).send({
            error: {
              code: 'wrong-chain',
              message: `event lives on chain ${event.chain_id}, not ${request.params.id}`,
            },
          });
        }

        const db = drizzle(app.pool);
        try {
          const [row] = await db
            .insert(chainPins)
            .values({
              userId: auth.userId,
              chainId: request.params.id,
              eventHash: parsed.data.event_hash,
              label: parsed.data.label ?? null,
            })
            .returning();
          if (!row) {
            return reply
              .code(500)
              .send({ error: { code: 'insert-failed', message: 'no row returned' } });
          }
          return reply.code(201).send({
            id: row.id,
            chain_id: row.chainId,
            event_hash: row.eventHash,
            label: row.label,
            created_at: row.createdAt.toISOString(),
            causal_sequence_marker: event.causal_sequence_marker.toString(),
          });
        } catch (err) {
          // Unique-index violation = already pinned. Return the existing
          // row rather than treating it as an error. Postgres surfaces this
          // as SQLSTATE 23505 (unique_violation), but drizzle wraps the raw
          // pg error in a DrizzleQueryError whose `code` lives on `.cause`,
          // not on the outer object. Inspect both, plus fall back to the
          // serialized message text in case the driver chain changes shape.
          const errObj = err as { code?: string; cause?: { code?: string }; message?: string };
          const code = errObj?.code ?? errObj?.cause?.code;
          const message = typeof errObj?.message === 'string' ? errObj.message : '';
          const isUniqueViolation = code === '23505' || /unique/i.test(message);
          if (isUniqueViolation) {
            const existing = (
              await db
                .select()
                .from(chainPins)
                .where(
                  and(
                    eq(chainPins.userId, auth.userId),
                    eq(chainPins.chainId, request.params.id),
                    eq(chainPins.eventHash, parsed.data.event_hash),
                  ),
                )
                .limit(1)
            )[0];
            if (existing) {
              return reply.code(200).send({
                id: existing.id,
                chain_id: existing.chainId,
                event_hash: existing.eventHash,
                label: existing.label,
                created_at: existing.createdAt.toISOString(),
                causal_sequence_marker: event.causal_sequence_marker.toString(),
                already_pinned: true,
              });
            }
          }
          throw err;
        }
      } finally {
        await ledger.close();
      }
    },
  );

  // GET /chains/:id/pins — list this user's pins on the chain.
  app.get<{ Params: { id: string } }>('/chains/:id/pins', async (request, reply) => {
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
        error: { code: verdict.reason, message: `cannot list pins on chain ${request.params.id}` },
      });
    }

    const db = drizzle(app.pool);
    const rows = await db
      .select()
      .from(chainPins)
      .where(and(eq(chainPins.userId, auth.userId), eq(chainPins.chainId, request.params.id)));
    return reply.send({
      chain_id: request.params.id,
      pins: rows.map((r) => ({
        id: r.id,
        event_hash: r.eventHash,
        label: r.label,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  // DELETE /chains/:id/pins/:pin_id — remove a pin.
  app.delete<{ Params: { id: string; pin_id: string } }>(
    '/chains/:id/pins/:pin_id',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const pinId = request.params.pin_id;
      if (!/^[0-9a-f-]{36}$/.test(pinId)) {
        return reply.code(400).send({ error: { code: 'invalid-id', message: 'malformed pin id' } });
      }

      const db = drizzle(app.pool);
      const [deleted] = await db
        .delete(chainPins)
        .where(
          and(
            eq(chainPins.id, pinId),
            eq(chainPins.userId, auth.userId),
            eq(chainPins.chainId, request.params.id),
          ),
        )
        .returning();
      if (!deleted) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'no such pin' } });
      }
      return reply.code(204).send();
    },
  );
};
