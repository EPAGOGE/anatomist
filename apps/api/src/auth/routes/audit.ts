// GET /auth/audit?limit=N
//
// Self-service security log. Walks the auth-events chain and returns
// events whose payload references the requesting user (by user_id when
// the event has one, or by email_lower for unknown-account failed
// logins). Lets a user see "every auth thing that happened to my
// account" without filing a support ticket.
//
// Privacy: this only returns events ABOUT the authed user — never
// other users' auth events, never platform-wide statistics.

import type { FastifyPluginAsync } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { createPostgresLedger } from '@epagoge/ledger';
import { decodeCbor, AuthEventPayloadSchema } from '@epagoge/shared';
import { users } from '../../db/schema.js';
import { verifyToken, type JwtKey } from '../jwt.js';
import { AUTH_EVENTS_CHAIN_ID } from '../auth-events.js';

export interface AuditPluginOptions {
  jwtKey: JwtKey;
}

const LOCAL_USER_SOURCE_ID = 'local_user';

interface AuditEntry {
  event_hash: string;
  kind: string;
  occurred_at: string;
  causal_sequence_marker: string;
  ip?: string | undefined;
  user_agent?: string | undefined;
  method?: string | undefined;
  reason?: string | undefined;
}

export const auditPlugin: FastifyPluginAsync<AuditPluginOptions> = async (app, opts) => {
  app.get<{ Querystring: { limit?: string } }>('/auth/audit', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return reply
        .code(401)
        .send({ error: { code: 'auth-required', message: 'bearer token required' } });
    }
    const v = verifyToken(header.slice('Bearer '.length), opts.jwtKey, { expectType: 'access' });
    if (!v.ok) {
      return reply.code(401).send({ error: { code: 'invalid-token', message: 'token rejected' } });
    }

    // Need the user's email_lower to match unknown-account failed logins.
    const db = drizzle(app.pool);
    const userRow = (await db.select().from(users).where(eq(users.id, v.claims.sub)).limit(1))[0];
    if (!userRow) {
      return reply
        .code(404)
        .send({ error: { code: 'user-not-found', message: 'subject user no longer exists' } });
    }
    const myUserId = userRow.id;
    const myEmailLower = userRow.emailLower;

    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50)));

    const ledger = createPostgresLedger({ pool: app.pool });
    try {
      const head = await ledger.getChainHead(AUTH_EVENTS_CHAIN_ID, LOCAL_USER_SOURCE_ID);
      if (!head) {
        return reply.send({ user_id: myUserId, entries: [] });
      }

      // Walk head → genesis, filtering payloads to those that reference
      // this user. The auth-events chain is small for any one user; we
      // accept linear scan here and let collection be bounded by limit.
      const entries: AuditEntry[] = [];
      let cursor: string | null = head.headHash;
      while (cursor && entries.length < limit) {
        const ev = await ledger.getEvent(cursor);
        if (!ev) break;
        const payload = await ledger.getEventPayload(cursor);
        if (payload) {
          try {
            const decoded = decodeCbor<unknown>(payload);
            const parsed = AuthEventPayloadSchema.safeParse(decoded);
            if (parsed.success) {
              const details = parsed.data.details as Record<string, unknown>;
              const eventUserId = details.user_id as string | undefined;
              const eventEmailLower = details.email_lower as string | undefined;
              const matches =
                (eventUserId && eventUserId === myUserId) ||
                (eventEmailLower && myEmailLower && eventEmailLower === myEmailLower);
              if (matches) {
                entries.push({
                  event_hash: cursor,
                  kind: parsed.data.kind,
                  occurred_at: details.occurred_at as string,
                  causal_sequence_marker: ev.causal_sequence_marker.toString(),
                  ip: details.ip as string | undefined,
                  user_agent: details.user_agent as string | undefined,
                  method: details.method as string | undefined,
                  reason: details.reason as string | undefined,
                });
              }
            }
          } catch {
            // Non-AuthEvent payload; skip.
          }
        }
        cursor = ev.causal_predecessors.length > 0 ? ev.causal_predecessors[0]! : null;
      }

      return reply.send({
        user_id: myUserId,
        entries,
        truncated: entries.length === limit,
      });
    } finally {
      await ledger.close();
    }
  });
};
