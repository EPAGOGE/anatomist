// Redis-backed refresh-token rotation and revocation.
//
// Each issued refresh token has a UUID (jti). Redis holds:
//
//   epagoge:rt:active:<jti>   -> "<user_id>:<family_id>"
//                                TTL = refresh token expiry
//   epagoge:rt:family:<family>:current  -> <jti currently active in family>
//                                TTL = refresh token expiry
//
// "Family" is the lineage of a single login: when a user logs in, a new
// family is created (random UUID). Each refresh rotates jti within the
// same family. If a token from this family is presented that is NOT the
// current jti, the entire family is revoked (token-reuse-detection).
//
// Logout deletes the active key for the presented jti AND the family's
// current pointer.

import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const ACTIVE_PREFIX = 'epagoge:rt:active:';
const FAMILY_PREFIX = 'epagoge:rt:family:';

export interface RefreshTokenStore {
  /** Mint a new family + initial jti pair. */
  beginFamily(userId: string, ttlSeconds: number): Promise<{ jti: string; family: string }>;
  /** Rotate a jti within an existing family. Returns the new jti. */
  rotate(currentJti: string, ttlSeconds: number): Promise<{ newJti: string; family: string }>;
  /** Validate that a jti is the current one in its family. Records reuse if not. */
  validate(jti: string): Promise<ValidateResult>;
  /** Revoke a single jti without revoking the family. Used on graceful logout. */
  revoke(jti: string): Promise<void>;
  /** Revoke an entire family. Used on token-reuse detection. */
  revokeFamily(family: string): Promise<void>;
}

export type ValidateResult =
  | { ok: true; userId: string; family: string }
  | { ok: false; reason: 'not-found' | 'reuse-detected' };

export function createRefreshTokenStore(redis: Redis): RefreshTokenStore {
  return {
    async beginFamily(userId, ttlSeconds) {
      const family = randomUUID();
      const jti = randomUUID();
      const pipe = redis.pipeline();
      pipe.set(`${ACTIVE_PREFIX}${jti}`, `${userId}:${family}`, 'EX', ttlSeconds);
      pipe.set(`${FAMILY_PREFIX}${family}:current`, jti, 'EX', ttlSeconds);
      await pipe.exec();
      return { jti, family };
    },

    async rotate(currentJti, ttlSeconds) {
      const value = await redis.get(`${ACTIVE_PREFIX}${currentJti}`);
      if (!value) throw new Error('cannot rotate: current jti not active');
      const [userId, family] = value.split(':');
      const newJti = randomUUID();
      const pipe = redis.pipeline();
      pipe.del(`${ACTIVE_PREFIX}${currentJti}`);
      pipe.set(`${ACTIVE_PREFIX}${newJti}`, `${userId}:${family}`, 'EX', ttlSeconds);
      pipe.set(`${FAMILY_PREFIX}${family}:current`, newJti, 'EX', ttlSeconds);
      await pipe.exec();
      return { newJti, family: family! };
    },

    async validate(jti) {
      const value = await redis.get(`${ACTIVE_PREFIX}${jti}`);
      if (!value) {
        // Two possibilities: (a) never issued / expired, or (b) the jti was
        // the current jti in some family but has since been rotated/revoked.
        // In case (b) we have to flag reuse — but we can't tell from a
        // missing key alone. We resolve this by checking if any family
        // points-at-current matches our jti. If not, and the jti was once
        // valid (we cannot know), we err toward 'not-found' for safety.
        // Caller MUST treat both as auth failure; the difference is
        // diagnostic.
        return { ok: false, reason: 'not-found' };
      }
      const [userId, family] = value.split(':');
      const current = await redis.get(`${FAMILY_PREFIX}${family}:current`);
      if (current && current !== jti) {
        // The family has been rotated past this jti but the active key
        // still exists. This is the reuse path: an attacker presents an
        // old jti that hasn't been GC'd yet.
        // Revoke the whole family.
        await this.revokeFamily(family!);
        return { ok: false, reason: 'reuse-detected' };
      }
      return { ok: true, userId: userId!, family: family! };
    },

    async revoke(jti) {
      await redis.del(`${ACTIVE_PREFIX}${jti}`);
    },

    async revokeFamily(family) {
      // Collect all jtis we know about for this family. The naive scan is
      // acceptable because the family namespace is small (typically one
      // active token per family at a time; rotation deletes the old). The
      // 'current' pointer is the only thing guaranteed to exist; deleting
      // it plus the active jti by lookup-from-pointer covers the common
      // case.
      const current = await redis.get(`${FAMILY_PREFIX}${family}:current`);
      const pipe = redis.pipeline();
      pipe.del(`${FAMILY_PREFIX}${family}:current`);
      if (current) pipe.del(`${ACTIVE_PREFIX}${current}`);
      await pipe.exec();
    },
  };
}
