import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { registerHttpUser, findUserByEmailLower } from '../register-http-user.js';
import { appendAuthEventWithPool } from '../auth-events.js';
import { issueAccessToken, issueRefreshToken, type JwtKey } from '../jwt.js';
import { createRefreshTokenStore } from '../refresh-tokens.js';
import type { MasterKey } from '../master-key.js';
import type { LocalIdentity } from '../../identity/local-key-store.js';

const RegisterBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(256),
  display_name: z.string().min(1).max(255),
});

export interface RegisterPluginOptions {
  master: MasterKey;
  jwtKey: JwtKey;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  /** The platform identity used to sign auth-events. */
  platformIdentity: LocalIdentity;
}

export const registerPlugin: FastifyPluginAsync<RegisterPluginOptions> = async (app, opts) => {
  app.post('/auth/register', async (request, reply) => {
    if (!app.pool || !app.redis) {
      return reply.code(500).send({
        error: { code: 'server-misconfigured', message: 'auth dependencies not wired' },
      });
    }

    const parsed = RegisterBodySchema.safeParse(request.body);
    if (!parsed.success) {
      // Per ADR-0039: failed registration attempts emit auth-registration-failed
      // (security-relevant attempt; rate-limited by @fastify/rate-limit at the
      // route layer). Reason 'malformed-request' distinguishes client bugs
      // from reconnaissance attempts.
      try {
        await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
          kind: 'auth-registration-failed',
          details: {
            ip: request.ip,
            user_agent: request.headers['user-agent'],
            reason: 'malformed-request',
            occurred_at: new Date().toISOString(),
          },
        });
      } catch (err) {
        app.log.error({ err }, 'failed to emit auth-registration-failed event');
      }
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid registration body',
          details: parsed.error.flatten(),
        },
      });
    }
    const { email, password, display_name } = parsed.data;
    const emailLower = email.trim().toLowerCase();

    const existing = await findUserByEmailLower(app.pool, emailLower);
    if (existing) {
      // Per ADR-0039: email-already-exists is reconnaissance-class
      // (an attacker can enumerate existing emails). Emit, but the rate
      // limiter and the timing-equalizer-on-login path together limit
      // information leakage.
      try {
        await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
          kind: 'auth-registration-failed',
          details: {
            email_lower: emailLower,
            ip: request.ip,
            user_agent: request.headers['user-agent'],
            reason: 'email-already-exists',
            occurred_at: new Date().toISOString(),
          },
        });
      } catch (err) {
        app.log.error({ err }, 'failed to emit auth-registration-failed event');
      }
      return reply.code(409).send({
        error: {
          code: 'email-taken',
          message: 'an account with this email already exists',
        },
      });
    }

    const sourceId = `user_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const result = await registerHttpUser({
      pool: app.pool,
      master: opts.master,
      email,
      password,
      displayName: display_name,
      sourceId,
    });

    // Emit auth-registration to auth-events chain (best-effort: failure is
    // logged but does not roll back the user creation).
    try {
      await appendAuthEventWithPool(app.pool, opts.platformIdentity, {
        kind: 'auth-registration',
        details: {
          user_id: result.userId,
          source_id: result.sourceId,
          email_lower: result.emailLower,
          ip: request.ip,
          user_agent: request.headers['user-agent'],
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      app.log.error({ err, userId: result.userId }, 'failed to emit auth-registration event');
    }

    // Issue tokens so the user is logged in immediately.
    const store = createRefreshTokenStore(app.redis);
    const { jti, family } = await store.beginFamily(result.userId, opts.jwtRefreshTtlSeconds);
    void family;
    const access = issueAccessToken(
      {
        userId: result.userId,
        sourceId: result.sourceId,
        ttlSeconds: opts.jwtAccessTtlSeconds,
      },
      opts.jwtKey,
    );
    const refresh = issueRefreshToken(
      {
        userId: result.userId,
        sourceId: result.sourceId,
        ttlSeconds: opts.jwtRefreshTtlSeconds,
        jti,
      },
      opts.jwtKey,
    );

    return reply.code(201).send({
      user: {
        id: result.userId,
        source_id: result.sourceId,
        email,
        display_name,
        chain_id: result.chainId,
        genesis_event_hash: result.genesisEventHash,
        public_key_fingerprints: {
          pq_blake3: result.publicKeyFingerprintPq,
          classical_blake3: result.publicKeyFingerprintClassical,
        },
      },
      access_token: access,
      access_token_expires_in: opts.jwtAccessTtlSeconds,
      refresh_token: refresh.token,
      refresh_token_expires_in: opts.jwtRefreshTtlSeconds,
    });
  });
};
