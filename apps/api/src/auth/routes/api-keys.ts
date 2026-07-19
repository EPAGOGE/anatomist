import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { mintApiKey } from '../api-keys.js';
import { appendAuthEventWithPool } from '../auth-events.js';
import { apiKeys } from '../../db/schema.js';
import type { JwtKey } from '../jwt.js';
import { verifyToken } from '../jwt.js';
import type { LocalIdentity } from '../../identity/local-key-store.js';

const CreateBodySchema = z.object({
  name: z.string().min(1).max(128),
  expires_at: z.string().datetime().optional(),
});

export interface ApiKeyPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

async function requireBearer(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtKey: JwtKey,
): Promise<{ userId: string; sourceId: string } | null> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
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

export const apiKeysPlugin: FastifyPluginAsync<ApiKeyPluginOptions> = async (app, opts) => {
  // POST /auth/api-keys → mint a new key, return plaintext exactly once
  app.post('/auth/api-keys', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = await requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const parsed = CreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid api key body',
          details: parsed.error.flatten(),
        },
      });
    }

    const minted = mintApiKey();
    const db = drizzle(app.pool);
    const [row] = await db
      .insert(apiKeys)
      .values({
        userId: auth.userId,
        name: parsed.data.name,
        keyHash: minted.keyHash,
        prefix: minted.prefix,
        expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
      })
      .returning();
    if (!row) {
      return reply
        .code(500)
        .send({ error: { code: 'insert-failed', message: 'api_keys insert returned no row' } });
    }

    try {
      await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
        kind: 'auth-api-key-issued',
        details: {
          user_id: auth.userId,
          api_key_id: row.id,
          name: row.name,
          expires_at: row.expiresAt?.toISOString(),
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      app.log.error({ err }, 'failed to emit auth-api-key-issued event');
    }

    return reply.code(201).send({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      expires_at: row.expiresAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      // Shown EXACTLY once. The caller stores it; we cannot recover it.
      plaintext: minted.plaintext,
    });
  });

  // GET /auth/api-keys → list current user's non-revoked keys
  app.get('/auth/api-keys', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = await requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const db = drizzle(app.pool);
    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, auth.userId), isNull(apiKeys.revokedAt)));

    return reply.send({
      api_keys: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        created_at: r.createdAt.toISOString(),
        expires_at: r.expiresAt?.toISOString() ?? null,
        last_used_at: r.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  // DELETE /auth/api-keys/:id → revoke a key
  app.delete<{ Params: { id: string } }>('/auth/api-keys/:id', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = await requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const id = request.params.id;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid-id', message: 'malformed api key id' } });
    }
    const db = drizzle(app.pool);
    const [updated] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, auth.userId), isNull(apiKeys.revokedAt)))
      .returning();
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not-found', message: 'no such active key' } });
    }
    try {
      await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
        kind: 'auth-api-key-revoked',
        details: {
          user_id: auth.userId,
          api_key_id: updated.id,
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      app.log.error({ err }, 'failed to emit auth-api-key-revoked event');
    }
    return reply.code(204).send();
  });
};
