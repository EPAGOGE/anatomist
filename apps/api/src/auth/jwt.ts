// JWT module (HS256). Issues short-lived access tokens and tracks long-lived
// refresh tokens via Redis (see refresh-tokens.ts).
//
// JWT_SECRET is a 256-bit hex-encoded symmetric key. We sign HS256 directly
// using node:crypto rather than @fastify/jwt to keep this module independent
// of Fastify state — easier to test, easier to call from non-route code.
//
// Token claims:
//   sub:  user UUID
//   sid:  source_id (string)
//   typ:  'access' | 'refresh'
//   jti:  token UUID (refresh tokens only; access tokens don't need it)
//   iat:  issued-at (seconds)
//   exp:  expiry (seconds)
//
// Access tokens carry typ='access' and no jti. Refresh tokens carry
// typ='refresh' and a jti that's also the Redis key for revocation.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface JwtClaims {
  sub: string;
  sid: string;
  typ: 'access' | 'refresh';
  jti?: string;
  iat: number;
  exp: number;
}

export interface JwtKey {
  readonly bytes: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function loadJwtKey(envKey?: string): JwtKey {
  const raw = envKey ?? process.env.JWT_SECRET;
  if (!raw) throw new Error('JWT_SECRET is not set; cannot sign tokens');
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error('JWT_SECRET must be 64 hex chars (256-bit symmetric key)');
  }
  return Object.freeze({ bytes: hexToBytes(raw) });
}

function b64urlEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

const HEADER = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
const HEADER_B64 = b64urlEncode(HEADER);

function sign(input: string, key: JwtKey): string {
  const mac = createHmac('sha256', Buffer.from(key.bytes));
  mac.update(input);
  return b64urlEncode(new Uint8Array(mac.digest()));
}

export interface IssueAccessOptions {
  userId: string;
  sourceId: string;
  ttlSeconds: number;
  now?: number; // for tests
}

export function issueAccessToken(opts: IssueAccessOptions, key: JwtKey): string {
  const iat = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    sub: opts.userId,
    sid: opts.sourceId,
    typ: 'access',
    iat,
    exp: iat + opts.ttlSeconds,
  };
  const payload = b64urlEncode(JSON.stringify(claims));
  const sig = sign(`${HEADER_B64}.${payload}`, key);
  return `${HEADER_B64}.${payload}.${sig}`;
}

export interface IssueRefreshOptions extends IssueAccessOptions {
  jti?: string; // caller supplies the UUID so it can record it in Redis
}

export interface IssuedRefresh {
  token: string;
  jti: string;
  claims: JwtClaims;
}

export function issueRefreshToken(opts: IssueRefreshOptions, key: JwtKey): IssuedRefresh {
  const iat = opts.now ?? Math.floor(Date.now() / 1000);
  const jti = opts.jti ?? randomUUID();
  const claims: JwtClaims = {
    sub: opts.userId,
    sid: opts.sourceId,
    typ: 'refresh',
    jti,
    iat,
    exp: iat + opts.ttlSeconds,
  };
  const payload = b64urlEncode(JSON.stringify(claims));
  const sig = sign(`${HEADER_B64}.${payload}`, key);
  return {
    token: `${HEADER_B64}.${payload}.${sig}`,
    jti,
    claims,
  };
}

export interface VerifyResult {
  ok: true;
  claims: JwtClaims;
}
export interface VerifyFailure {
  ok: false;
  reason: 'malformed' | 'bad-signature' | 'expired' | 'wrong-type';
}

export function verifyToken(
  token: string,
  key: JwtKey,
  options: { expectType?: 'access' | 'refresh'; now?: number } = {},
): VerifyResult | VerifyFailure {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts;
  if (h !== HEADER_B64) return { ok: false, reason: 'malformed' };

  const expectedSig = sign(`${h}.${p}`, key);
  const given = Buffer.from(s!, 'utf8');
  const expected = Buffer.from(expectedSig, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(b64urlDecode(p!).toString('utf8')) as JwtClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (options.expectType && claims.typ !== options.expectType) {
    return { ok: false, reason: 'wrong-type' };
  }
  return { ok: true, claims };
}
