// Chat session persistence — F: durable, per-user Chat page conversations.
//
//   GET    /chat/sessions        — list this user's sessions (newest first)
//   PUT    /chat/sessions/:id    — upsert a session (client-generated id)
//   DELETE /chat/sessions/:id    — delete a session
//
// Pure UI state, NOT a ledger chain (unlike projects/canvas): no signed
// event is emitted. Every row is owner-scoped by the JWT subject, so one
// user can never read or overwrite another's chats.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import { verifyToken, type JwtKey } from '../auth/jwt.js';
import { chatSessions } from '../db/schema.js';

export interface ChatSessionsPluginOptions {
  jwtKey: JwtKey;
}

function requireBearer(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtKey: JwtKey,
): { userId: string } | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    // Local-first: no token means the local owner (see auth/local-user.ts).
    const local = request.server.localIdentity;
    if (local) return { userId: local.userId };
    reply.code(401).send({ error: { code: 'auth-required', message: 'bearer token required' } });
    return null;
  }
  const v = verifyToken(header.slice('Bearer '.length), jwtKey, { expectType: 'access' });
  if (!v.ok) {
    reply.code(401).send({ error: { code: 'invalid-token', message: 'token rejected' } });
    return null;
  }
  return { userId: v.claims.sub };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate the entry shape loosely: role + content are enforced; response
// metadata (meta / frontierMeta) is passed through opaquely.
const EntrySchema = z
  .object({ role: z.enum(['user', 'assistant']), content: z.string() })
  .passthrough();
const UpsertBodySchema = z.object({
  title: z.string().min(1).max(200),
  entries: z.array(EntrySchema).max(2000),
});

export const chatSessionsPlugin: FastifyPluginAsync<ChatSessionsPluginOptions> = async (
  app,
  opts,
) => {
  app.get('/chat/sessions', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const db = drizzle(app.pool);
    const rows = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.ownerUserId, auth.userId))
      .orderBy(desc(chatSessions.updatedAt));

    return {
      sessions: rows.map((r) => ({
        id: r.id,
        title: r.title,
        entries: r.entries,
        createdAt: r.createdAt.getTime(),
        updatedAt: r.updatedAt.getTime(),
      })),
    };
  });

  app.put<{ Params: { id: string } }>('/chat/sessions/:id', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid-id', message: 'session id must be a uuid' } });
    }
    const parsed = UpsertBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid session body',
          details: parsed.error.flatten(),
        },
      });
    }
    const { title, entries } = parsed.data;
    const db = drizzle(app.pool);
    const now = new Date();
    // Upsert, but only update a row this user already owns — a colliding id
    // owned by someone else is never overwritten.
    await db
      .insert(chatSessions)
      .values({ id, ownerUserId: auth.userId, title, entries, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: chatSessions.id,
        set: { title, entries, updatedAt: now },
        where: eq(chatSessions.ownerUserId, auth.userId),
      });

    return reply.code(200).send({ ok: true, id });
  });

  app.delete<{ Params: { id: string } }>('/chat/sessions/:id', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const db = drizzle(app.pool);
    await db
      .delete(chatSessions)
      .where(
        and(eq(chatSessions.id, request.params.id), eq(chatSessions.ownerUserId, auth.userId)),
      );

    return reply.code(200).send({ ok: true });
  });
};
