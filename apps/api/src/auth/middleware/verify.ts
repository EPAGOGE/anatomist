// Auth middleware. Handler routes that need authentication attach these
// preHandlers; the result is set on request.auth.

import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { verifyToken, type JwtKey } from '../jwt.js';
import { parseApiKey, verifyApiKeyAgainstRow } from '../api-keys.js';
import { apiKeys } from '../../db/schema.js';

export interface AuthIdentity {
  userId: string;
  sourceId: string;
  method: 'jwt' | 'api-key';
  apiKeyId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthIdentity;
  }
}

/**
 * Verify a request via JWT (Authorization: Bearer ...) or API key
 * (Authorization: ApiKey ... OR X-Api-Key: ...). Either succeeds — sets
 * request.auth and resolves — or rejects the request with 401.
 */
export function requireAuth(jwtKey: JwtKey): preHandlerAsyncHookHandler {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization ?? '';
    const xApiKey = request.headers['x-api-key'];

    // JWT path
    if (header.startsWith('Bearer ')) {
      const v = verifyToken(header.slice('Bearer '.length), jwtKey, { expectType: 'access' });
      if (!v.ok) {
        reply.code(401).send({ error: { code: 'invalid-token', message: 'token rejected' } });
        return;
      }
      request.auth = { userId: v.claims.sub, sourceId: v.claims.sid, method: 'jwt' };
      return;
    }

    // API key path
    let apiKeyCandidate: string | undefined;
    if (header.startsWith('ApiKey ')) apiKeyCandidate = header.slice('ApiKey '.length).trim();
    else if (typeof xApiKey === 'string') apiKeyCandidate = xApiKey;

    if (!apiKeyCandidate) {
      reply
        .code(401)
        .send({ error: { code: 'auth-required', message: 'bearer or api key required' } });
      return;
    }
    if (!request.server.pool) {
      reply.code(500).send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      return;
    }
    const parsed = parseApiKey(apiKeyCandidate);
    if (!parsed) {
      reply.code(401).send({ error: { code: 'invalid-api-key', message: 'malformed api key' } });
      return;
    }
    const db = drizzle(request.server.pool);
    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row || !verifyApiKeyAgainstRow(parsed.secret, row)) {
      reply.code(401).send({ error: { code: 'invalid-api-key', message: 'api key rejected' } });
      return;
    }
    // Best-effort last_used_at touch (fire-and-forget; failure non-fatal).
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => undefined);

    request.auth = {
      userId: row.userId,
      // The user's source_id; needs a separate lookup. Defer this — most
      // handlers don't need sourceId on the api-key path. If they do, they
      // can query users by id themselves.
      sourceId: '',
      method: 'api-key',
      apiKeyId: row.id,
    };
  };
}
