import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { issueAccessToken, issueRefreshToken, verifyToken, type JwtKey } from '../jwt.js';
import { createRefreshTokenStore } from '../refresh-tokens.js';
import { appendAuthEventWithPool } from '../auth-events.js';
import type { LocalIdentity } from '../../identity/local-key-store.js';

const BodySchema = z.object({ refresh_token: z.string().min(1) });

export interface RefreshPluginOptions {
  jwtKey: JwtKey;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  /** The platform identity used to sign auth-events. */
  platformIdentity: LocalIdentity;
}

export const refreshPlugin: FastifyPluginAsync<RefreshPluginOptions> = async (app, opts) => {
  app.post('/auth/refresh', async (request, reply) => {
    if (!app.redis || !app.pool) {
      return reply.code(500).send({
        error: { code: 'server-misconfigured', message: 'auth dependencies not wired' },
      });
    }

    // Per ADR-0039: failed refresh attempts emit auth-refresh-failed. The
    // reason field distinguishes stolen-token reuse (revoked), ordinary
    // expiration (expired), tampering (invalid-signature), and client bugs
    // (missing-jti / malformed-request). Rate-limited by global 100/min
    // limiter; the chain record provides the auditable trail.
    const emitFailed = async (
      reason: 'invalid-signature' | 'expired' | 'revoked' | 'missing-jti' | 'malformed-request',
    ) => {
      try {
        await appendAuthEventWithPool(app.pool!, opts.platformIdentity, {
          kind: 'auth-refresh-failed',
          details: {
            ip: request.ip,
            user_agent: request.headers['user-agent'],
            reason,
            occurred_at: new Date().toISOString(),
          },
        });
      } catch (err) {
        app.log.error({ err }, 'failed to emit auth-refresh-failed event');
      }
    };

    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) {
      await emitFailed('malformed-request');
      return reply
        .code(400)
        .send({ error: { code: 'invalid-request', message: 'missing refresh_token' } });
    }
    const verification = verifyToken(parsed.data.refresh_token, opts.jwtKey, {
      expectType: 'refresh',
    });
    if (!verification.ok) {
      // Map jwt.ts VerifyFailure reasons onto the chain payload enum.
      // 'wrong-type' (e.g. an access token presented to /refresh) is a
      // client bug, classified as 'malformed-request'.
      const reason =
        verification.reason === 'expired'
          ? 'expired'
          : verification.reason === 'bad-signature'
            ? 'invalid-signature'
            : 'malformed-request';
      await emitFailed(reason);
      return reply
        .code(401)
        .send({ error: { code: 'invalid-refresh-token', message: 'token rejected' } });
    }
    const claims = verification.claims;
    if (!claims.jti) {
      await emitFailed('missing-jti');
      return reply
        .code(401)
        .send({ error: { code: 'invalid-refresh-token', message: 'token missing jti' } });
    }
    const store = createRefreshTokenStore(app.redis);
    const valid = await store.validate(claims.jti);
    if (!valid.ok) {
      // reuse-detected: family was revoked inside validate(). Either way the
      // user must re-authenticate from scratch.
      await emitFailed('revoked');
      return reply
        .code(401)
        .send({ error: { code: 'invalid-refresh-token', message: 'token revoked' } });
    }

    const { newJti } = await store.rotate(claims.jti, opts.jwtRefreshTtlSeconds);
    const access = issueAccessToken(
      {
        userId: claims.sub,
        sourceId: claims.sid,
        ttlSeconds: opts.jwtAccessTtlSeconds,
      },
      opts.jwtKey,
    );
    const refresh = issueRefreshToken(
      {
        userId: claims.sub,
        sourceId: claims.sid,
        ttlSeconds: opts.jwtRefreshTtlSeconds,
        jti: newJti,
      },
      opts.jwtKey,
    );

    // Per ADR-0039: successful refresh is a NAMED EXCEPTION to the
    // state-changing-emits rule. Refresh rotates a refresh-token-family
    // jti (state change in Redis) but does NOT emit. The auth-login that
    // bootstrapped the family already established attributable session
    // origin in the chain, and refresh produces no new identity claim.
    // Emitting on every refresh would dilute the audit trail with
    // high-frequency low-information events. Reuse-detection (the
    // adversarial case) IS recorded above via the 'revoked' branch.

    return reply.send({
      access_token: access,
      access_token_expires_in: opts.jwtAccessTtlSeconds,
      refresh_token: refresh.token,
      refresh_token_expires_in: opts.jwtRefreshTtlSeconds,
    });
  });
};
