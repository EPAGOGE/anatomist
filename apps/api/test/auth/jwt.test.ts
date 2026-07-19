import { describe, it, expect } from 'vitest';
import {
  loadJwtKey,
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
} from '../../src/auth/jwt.js';

const HEX_64 = '1'.repeat(64);
const HEX_64_OTHER = '2'.repeat(64);

describe('jwt', () => {
  const key = loadJwtKey(HEX_64);

  it('issues an access token and verifies it', () => {
    const token = issueAccessToken(
      { userId: 'u1', sourceId: 'sid', ttlSeconds: 60, now: 1000 },
      key,
    );
    const v = verifyToken(token, key, { expectType: 'access', now: 1000 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.sub).toBe('u1');
      expect(v.claims.sid).toBe('sid');
      expect(v.claims.typ).toBe('access');
      expect(v.claims.exp).toBe(1060);
    }
  });

  it('rejects expired token', () => {
    const token = issueAccessToken(
      { userId: 'u1', sourceId: 'sid', ttlSeconds: 60, now: 1000 },
      key,
    );
    const v = verifyToken(token, key, { now: 2000 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('expired');
  });

  it('rejects tampered signature', () => {
    const token = issueAccessToken(
      { userId: 'u1', sourceId: 'sid', ttlSeconds: 60, now: 1000 },
      key,
    );
    const parts = token.split('.');
    const sig = parts[2]!;
    const tampered = `${parts[0]}.${parts[1]}.${sig.replace(/.$/, sig.endsWith('A') ? 'B' : 'A')}`;
    const v = verifyToken(tampered, key, { now: 1000 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad-signature');
  });

  it('rejects token signed with different key', () => {
    const other = loadJwtKey(HEX_64_OTHER);
    const token = issueAccessToken(
      { userId: 'u1', sourceId: 'sid', ttlSeconds: 60, now: 1000 },
      other,
    );
    const v = verifyToken(token, key, { now: 1000 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad-signature');
  });

  it('issues a refresh token with a jti', () => {
    const r = issueRefreshToken({ userId: 'u1', sourceId: 'sid', ttlSeconds: 300, now: 1000 }, key);
    expect(r.jti).toMatch(/^[0-9a-f-]{36}$/);
    const v = verifyToken(r.token, key, { expectType: 'refresh', now: 1000 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.typ).toBe('refresh');
      expect(v.claims.jti).toBe(r.jti);
    }
  });

  it('rejects access token presented as refresh and vice versa', () => {
    const access = issueAccessToken(
      { userId: 'u1', sourceId: 'sid', ttlSeconds: 60, now: 1000 },
      key,
    );
    const refresh = issueRefreshToken(
      { userId: 'u1', sourceId: 'sid', ttlSeconds: 300, now: 1000 },
      key,
    );
    const v1 = verifyToken(access, key, { expectType: 'refresh', now: 1000 });
    const v2 = verifyToken(refresh.token, key, { expectType: 'access', now: 1000 });
    expect(v1.ok).toBe(false);
    expect(v2.ok).toBe(false);
    if (!v1.ok) expect(v1.reason).toBe('wrong-type');
    if (!v2.ok) expect(v2.reason).toBe('wrong-type');
  });

  it('rejects malformed token strings', () => {
    expect(verifyToken('not-a-token', key, { now: 1000 }).ok).toBe(false);
    expect(verifyToken('a.b', key, { now: 1000 }).ok).toBe(false);
    expect(verifyToken('a.b.c.d', key, { now: 1000 }).ok).toBe(false);
  });
});
