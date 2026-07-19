import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyToken, type JwtKey } from '../jwt.js';
import { createRefreshTokenStore } from '../refresh-tokens.js';
import { appendAuthEventWithPool } from '../auth-events.js';
import type { LocalIdentity } from '../../identity/local-key-store.js';

const BodySchema = z.object({ refresh_token: z.string().min(1) });

export interface LogoutPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

export const logoutPlugin: FastifyPluginAsync<LogoutPluginOptions> = async (app, opts) => {
  app.post('/auth/logout', async (request, reply) => {
    if (!app.redis) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'redis not wired' } });
    }
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid-request', message: 'missing refresh_token' } });
    }
    const verification = verifyToken(parsed.data.refresh_token, opts.jwtKey, {
      expectType: 'refresh',
    });
    // Even if the token is invalid we return 204 — logout should be
    // idempotent and shouldn't leak info about token validity.
    if (verification.ok && verification.claims.jti) {
      const store = createRefreshTokenStore(app.redis);
      await store.revoke(verification.claims.jti);

      if (app.pool) {
        try {
          await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
            kind: 'auth-logout',
            details: {
              user_id: verification.claims.sub,
              refresh_token_uuid: verification.claims.jti,
              ip: request.ip,
              occurred_at: new Date().toISOString(),
            },
          });
        } catch (err) {
          app.log.error({ err }, 'failed to emit auth-logout event');
        }
      }
    }
    return reply.code(204).send();
  });
};
