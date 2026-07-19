import Redis from 'ioredis';
import { hashPassword, verifyPassword, ARGON2ID_PARAMS } from '../../auth/password.js';
import { issueAccessToken, issueRefreshToken, verifyToken, loadJwtKey } from '../../auth/jwt.js';
import { createRefreshTokenStore } from '../../auth/refresh-tokens.js';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const KNOWN_PASSWORD = 'epagoge-doctor-known-value';
const WRONG_PASSWORD = 'epagoge-doctor-wrong-value';

export const argon2idCheck: Check = makeCheck('argon2id-roundtrip', async () => {
  const hash = await hashPassword(KNOWN_PASSWORD);
  if (!hash.startsWith('$argon2id$')) {
    throw new Error(`hash did not use argon2id variant: ${hash.slice(0, 16)}`);
  }
  // Verify the params landed in the encoded string. Library encodes them as
  // m=<memory>,t=<time>,p=<parallel>.
  const paramSegment = hash.match(/m=(\d+),t=(\d+),p=(\d+)/);
  if (!paramSegment) {
    throw new Error('encoded hash missing m=/t=/p= params');
  }
  const [, m, t, p] = paramSegment;
  if (
    Number(m) !== ARGON2ID_PARAMS.memoryCost ||
    Number(t) !== ARGON2ID_PARAMS.timeCost ||
    Number(p) !== ARGON2ID_PARAMS.parallelism
  ) {
    throw new Error(`params mismatch: encoded m=${m},t=${t},p=${p}`);
  }

  const matches = await verifyPassword(KNOWN_PASSWORD, hash);
  if (!matches) throw new Error('verify of known-good password returned false');
  const wrongMatches = await verifyPassword(WRONG_PASSWORD, hash);
  if (wrongMatches) throw new Error('verify of wrong password returned true');
  return `m=${ARGON2ID_PARAMS.memoryCost} t=${ARGON2ID_PARAMS.timeCost} p=${ARGON2ID_PARAMS.parallelism}, verify+tamper reject`;
});

export const jwtCheck: Check = makeCheck('jwt-roundtrip', async () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not set');
  }
  const key = loadJwtKey(secret);
  const access = issueAccessToken({ userId: 'doctor', sourceId: 'doctor', ttlSeconds: 60 }, key);
  const v = verifyToken(access, key, { expectType: 'access' });
  if (!v.ok) throw new Error(`access token verify failed: ${v.reason}`);
  if (v.claims.sub !== 'doctor' || v.claims.sid !== 'doctor') {
    throw new Error('access token claims mismatch');
  }

  // Tamper rejection: flip a byte in the signature.
  const parts = access.split('.');
  const sig = parts[2]!;
  const tampered = `${parts[0]}.${parts[1]}.${sig.replace(/.$/, sig.endsWith('A') ? 'B' : 'A')}`;
  const tv = verifyToken(tampered, key, { expectType: 'access' });
  if (tv.ok) throw new Error('tampered token verified ok (should reject)');

  // Type rejection: refresh issued, verify as access fails.
  const refresh = issueRefreshToken({ userId: 'doctor', sourceId: 'doctor', ttlSeconds: 60 }, key);
  const wrongType = verifyToken(refresh.token, key, { expectType: 'access' });
  if (wrongType.ok) throw new Error('refresh token accepted as access (should reject)');

  return `access verify ok, tamper rejected, type rejected`;
});

export function refreshTokenRedisCheck(redisUrl: string): Check {
  return makeCheck('refresh-token-redis', async () => {
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      const store = createRefreshTokenStore(redis);
      const { jti } = await store.beginFamily('doctor-user', 60);

      const v1 = await store.validate(jti);
      if (!v1.ok) throw new Error(`first validate failed: ${v1.reason}`);
      if (v1.userId !== 'doctor-user') throw new Error('userId mismatch on validate');

      const { newJti } = await store.rotate(jti, 60);

      // Old jti should now be flagged as reuse if presented again, OR
      // simply not-found (the rotate deleted its active key). Either is
      // acceptable as auth failure; we test both branches don't accept.
      const reuse = await store.validate(jti);
      if (reuse.ok) throw new Error('rotated jti still validated as current (should not)');

      const v2 = await store.validate(newJti);
      if (!v2.ok) throw new Error(`new jti validate failed: ${v2.reason}`);

      await store.revoke(newJti);
      const v3 = await store.validate(newJti);
      if (v3.ok) throw new Error('revoked jti still validated (should not)');

      return 'begin/validate/rotate/reuse-blocked/revoke/post-revoke-reject';
    } finally {
      redis.disconnect();
    }
  });
}
