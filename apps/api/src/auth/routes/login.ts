import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { findUserByEmailLower } from '../register-http-user.js';
import { verifyPassword, timingEqualizer } from '../password.js';
import { issueAccessToken, issueRefreshToken, type JwtKey } from '../jwt.js';
import { createRefreshTokenStore } from '../refresh-tokens.js';
import { appendAuthEventWithPool } from '../auth-events.js';
import type { LocalIdentity } from '../../identity/local-key-store.js';

const LoginBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

const GENERIC_FAILURE = {
  error: {
    code: 'invalid-credentials',
    message: 'invalid email or password',
  },
};

export interface LoginPluginOptions {
  jwtKey: JwtKey;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  platformIdentity: LocalIdentity;
}

export const loginPlugin: FastifyPluginAsync<LoginPluginOptions> = async (app, opts) => {
  app.post('/auth/login', async (request, reply) => {
    if (!app.pool || !app.redis) {
      return reply.code(500).send({
        error: { code: 'server-misconfigured', message: 'auth dependencies not wired' },
      });
    }

    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      // Don't reveal validation details on login: shape errors leak info
      // about which fields are present.
      return reply.code(400).send(GENERIC_FAILURE);
    }
    const { email, password } = parsed.data;
    const emailLower = email.trim().toLowerCase();

    const user = await findUserByEmailLower(app.pool, emailLower);
    if (!user || !user.passwordHash) {
      // Spend roughly the same time as a real argon2 verify so timing
      // cannot reveal account existence.
      await timingEqualizer();
      // Best-effort log of failed attempt without revealing reason.
      try {
        await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
          kind: 'auth-login-failed',
          details: {
            email_lower: emailLower,
            ip: request.ip,
            user_agent: request.headers['user-agent'],
            reason: user ? 'invalid-credentials' : 'unknown-account',
            occurred_at: new Date().toISOString(),
          },
        });
      } catch (err) {
        app.log.error({ err }, 'failed to emit auth-login-failed event');
      }
      return reply.code(401).send(GENERIC_FAILURE);
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (!passwordOk) {
      try {
        await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
          kind: 'auth-login-failed',
          details: {
            email_lower: emailLower,
            ip: request.ip,
            user_agent: request.headers['user-agent'],
            reason: 'invalid-credentials',
            occurred_at: new Date().toISOString(),
          },
        });
      } catch (err) {
        app.log.error({ err }, 'failed to emit auth-login-failed event');
      }
      return reply.code(401).send(GENERIC_FAILURE);
    }

    // Issue tokens.
    const store = createRefreshTokenStore(app.redis);
    const { jti } = await store.beginFamily(user.id, opts.jwtRefreshTtlSeconds);
    const access = issueAccessToken(
      {
        userId: user.id,
        sourceId: user.sourceId,
        ttlSeconds: opts.jwtAccessTtlSeconds,
      },
      opts.jwtKey,
    );
    const refresh = issueRefreshToken(
      {
        userId: user.id,
        sourceId: user.sourceId,
        ttlSeconds: opts.jwtRefreshTtlSeconds,
        jti,
      },
      opts.jwtKey,
    );

    try {
      await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
        kind: 'auth-login',
        details: {
          user_id: user.id,
          source_id: user.sourceId,
          ip: request.ip,
          user_agent: request.headers['user-agent'],
          method: 'password',
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      app.log.error({ err, userId: user.id }, 'failed to emit auth-login event');
    }

    return reply.send({
      user: {
        id: user.id,
        source_id: user.sourceId,
        email: user.email,
        display_name: user.displayName,
      },
      access_token: access,
      access_token_expires_in: opts.jwtAccessTtlSeconds,
      refresh_token: refresh.token,
      refresh_token_expires_in: opts.jwtRefreshTtlSeconds,
    });
  });
};
