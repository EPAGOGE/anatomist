import { describe, it, expect, afterAll } from 'vitest';
import Redis from 'ioredis';
import { createRefreshTokenStore } from '../../src/auth/refresh-tokens.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function redisReachable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  // ioredis emits an 'error' EVENT on connect failure in addition to the
  // rejected promise; without a listener that event is "unhandled" and
  // poisons vitest's exit code even though the catch below handles it.
  r.on('error', () => undefined);
  try {
    await r.connect();
    await r.ping();
    r.disconnect();
    return true;
  } catch {
    r.disconnect();
    return false;
  }
}

const live = await redisReachable();
const describeLive = live ? describe : describe.skip;

describeLive('refresh-tokens (live Redis)', () => {
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const store = createRefreshTokenStore(redis);

  afterAll(async () => {
    // Clean any leftover keys (best-effort).
    const keys = await redis.keys('epagoge:rt:*');
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it('begin + validate + rotate + post-rotate-reuse detects family', async () => {
    const { jti, family } = await store.beginFamily('user-a', 60);

    const v1 = await store.validate(jti);
    expect(v1.ok).toBe(true);
    if (v1.ok) expect(v1.userId).toBe('user-a');

    const { newJti } = await store.rotate(jti, 60);

    // The new jti validates.
    const v2 = await store.validate(newJti);
    expect(v2.ok).toBe(true);

    // The old jti either is gone (not-found) or, if it lingered, would be
    // reuse-detected. In either case validate returns ok:false.
    const v3 = await store.validate(jti);
    expect(v3.ok).toBe(false);

    void family;
  });

  it('revoke removes the active jti', async () => {
    const { jti } = await store.beginFamily('user-b', 60);
    await store.revoke(jti);
    const v = await store.validate(jti);
    expect(v.ok).toBe(false);
  });

  it('revokeFamily kills the current jti', async () => {
    const { jti, family } = await store.beginFamily('user-c', 60);
    await store.revokeFamily(family);
    const v = await store.validate(jti);
    expect(v.ok).toBe(false);
  });

  it('rotate on an unknown jti throws', async () => {
    await expect(store.rotate('not-a-known-jti', 60)).rejects.toThrow();
  });
});
