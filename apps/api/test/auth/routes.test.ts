import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID, randomBytes } from 'node:crypto';
import { createPostgresLedger } from '@epagoge/ledger';
import { buildServer } from '../../src/server.js';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';
import { users, chainHeads, chainOwners, events, apiKeys } from '../../src/db/schema.js';
import { userPrimaryChainId } from '@epagoge/ledger';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function dbReachable(): Promise<boolean> {
  const probe = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    const c = await probe.connect();
    c.release();
    await probe.end();
    return true;
  } catch {
    await probe.end().catch(() => undefined);
    return false;
  }
}

const live = await dbReachable();
const describeLive = live ? describe : describe.skip;

// Use fresh hex keys per test run so we don't collide with other suites.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

describeLive('auth routes (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });
  const insertedEmails: string[] = [];

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    const db = drizzle(pool);
    for (const email of insertedEmails) {
      const userRow = (
        await db.select().from(users).where(eq(users.emailLower, email)).limit(1)
      )[0];
      if (!userRow) continue;
      const chainId = userPrimaryChainId(userRow.id);
      // FK cascade from users → api_keys handles api_keys; manual cleanup of
      // chain artifacts.
      await db.delete(chainHeads).where(eq(chainHeads.chainId, chainId));
      await db.delete(events).where(eq(events.chainId, chainId));
      await db.delete(chainOwners).where(eq(chainOwners.chainId, chainId));
      await db.delete(apiKeys).where(eq(apiKeys.userId, userRow.id));
      await db.delete(users).where(eq(users.id, userRow.id));
    }
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  function freshEmail(): string {
    const e = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    insertedEmails.push(e.toLowerCase());
    return e;
  }

  it('POST /auth/register creates a user, returns tokens + chain info', async () => {
    const email = freshEmail();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Tester' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe(email);
    expect(body.user.chain_id).toMatch(/^user-primary:/);
    expect(body.user.genesis_event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.user.public_key_fingerprints.pq_blake3).toMatch(/^[0-9a-f]{64}$/);
    expect(body.access_token.split('.').length).toBe(3);
    expect(body.refresh_token.split('.').length).toBe(3);
  });

  it('POST /auth/register rejects a duplicate email', async () => {
    const email = freshEmail();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Tester' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'another-long-pass', display_name: 'Other' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('POST /auth/login succeeds with correct password', async () => {
    const email = freshEmail();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'L' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'sufficiently-long-pass' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token.split('.').length).toBe(3);
  });

  it('POST /auth/login returns invalid-credentials for wrong password', async () => {
    const email = freshEmail();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'L' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'wrong-pass' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid-credentials');
  });

  it('POST /auth/login returns invalid-credentials for unknown email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: `nobody-${randomUUID().slice(0, 8)}@epagoge-test.local`,
        password: 'whatever',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid-credentials');
  });

  it('POST /auth/refresh rotates and issues a new access + refresh', async () => {
    const email = freshEmail();
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'R' },
    });
    const { refresh_token } = reg.json();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.refresh_token).not.toBe(refresh_token);

    // The OLD refresh token must now fail.
    const reused = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token },
    });
    expect(reused.statusCode).toBe(401);
  });

  it('POST /auth/logout revokes the presented refresh token', async () => {
    const email = freshEmail();
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'O' },
    });
    const { refresh_token } = reg.json();
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refresh_token },
    });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token },
    });
    expect(after.statusCode).toBe(401);
  });

  it('POST /auth/api-keys mints a key (returned exactly once)', async () => {
    const email = freshEmail();
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'K' },
    });
    const { access_token } = reg.json();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${access_token}` },
      payload: { name: 'integration-test' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.plaintext.startsWith('epak_')).toBe(true);
    expect(body.prefix.length).toBe(16);

    // List should include it.
    const list = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(list.statusCode).toBe(200);
    const arr = list.json().api_keys;
    expect(arr.find((k: { id: string }) => k.id === body.id)).toBeTruthy();

    // Revoke it.
    const del = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${body.id}`,
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(del.statusCode).toBe(204);

    // List should no longer include it.
    const list2 = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(list2.json().api_keys.find((k: { id: string }) => k.id === body.id)).toBeUndefined();
  });

  it('rejects api-key creation without a Bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      payload: { name: 'no-auth' },
    });
    expect(res.statusCode).toBe(401);
  });

  // Per ADR-0039 + Criterion 4: failure paths must emit signed chain events.
  // These tests are explicit assertions that the *-failed events land on
  // the auth-events chain — the pre-existing tests verified HTTP response
  // codes but did not check chain-emission as a side effect, which is how
  // the original gap (register-failed / refresh-failed missing) hid.
  //
  // The walk reads the auth-events chain head (single-writer, source_id
  // 'local_user') and scans backward looking for the expected kind + reason.
  // Bounded by maxScan; the chain is small in test scope.
  describe('ADR-0039 failure-path chain emission', () => {
    async function findRecentAuthEvent(
      kind: string,
      reason: string,
      maxScan = 50,
    ): Promise<{ kind: string; reason?: string } | null> {
      const { decodeCbor, AuthEventPayloadSchema } = await import('@epagoge/shared');
      const { AUTH_EVENTS_CHAIN_ID } = await import('../../src/auth/auth-events.js');
      const head = await ledger.getChainHead(AUTH_EVENTS_CHAIN_ID, 'local_user');
      if (!head) return null;
      let cursor: string | null = head.headHash;
      for (let i = 0; cursor && i < maxScan; i++) {
        const ev = await ledger.getEvent(cursor);
        if (!ev) break;
        const payload = await ledger.getEventPayload(cursor);
        if (payload) {
          try {
            const parsed = AuthEventPayloadSchema.safeParse(decodeCbor<unknown>(payload));
            if (parsed.success) {
              const details = parsed.data.details as Record<string, unknown>;
              if (parsed.data.kind === kind && details.reason === reason) {
                return { kind: parsed.data.kind, reason: details.reason as string };
              }
            }
          } catch {
            // skip undecodable event
          }
        }
        cursor = ev.causal_predecessors[0] ?? null;
      }
      return null;
    }

    it('register malformed-request emits auth-registration-failed', async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'not-an-email', password: 'short', display_name: '' },
      });
      const found = await findRecentAuthEvent('auth-registration-failed', 'malformed-request');
      expect(found).not.toBeNull();
      expect(found?.reason).toBe('malformed-request');
    });

    it('register duplicate-email emits auth-registration-failed', async () => {
      const email = freshEmail();
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'sufficiently-long-pass', display_name: 'Dup' },
      });
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'another-long-pass', display_name: 'Dup2' },
      });
      const found = await findRecentAuthEvent('auth-registration-failed', 'email-already-exists');
      expect(found).not.toBeNull();
      expect(found?.reason).toBe('email-already-exists');
    });

    it('refresh malformed-request emits auth-refresh-failed', async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {},
      });
      const found = await findRecentAuthEvent('auth-refresh-failed', 'malformed-request');
      expect(found).not.toBeNull();
    });

    it('refresh bad-signature emits auth-refresh-failed invalid-signature', async () => {
      // Take a real token, flip the last char of its signature part. This
      // exercises the bad-signature branch in jwt.ts verifyToken; using a
      // garbage three-part string instead would hit the malformed branch
      // (wrong header) — different reason on the chain.
      const email = freshEmail();
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'sufficiently-long-pass', display_name: 'Sig' },
      });
      const { refresh_token } = reg.json();
      const tampered = refresh_token.slice(0, -1) + (refresh_token.endsWith('A') ? 'B' : 'A');
      await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token: tampered },
      });
      const found = await findRecentAuthEvent('auth-refresh-failed', 'invalid-signature');
      expect(found).not.toBeNull();
    });

    it('refresh revoked-token emits auth-refresh-failed revoked', async () => {
      const email = freshEmail();
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'sufficiently-long-pass', display_name: 'Rev' },
      });
      const { refresh_token } = reg.json();
      // First refresh rotates and invalidates the old token.
      await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token } });
      // Reuse → revoked path.
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token },
      });
      expect(res.statusCode).toBe(401);
      const found = await findRecentAuthEvent('auth-refresh-failed', 'revoked');
      expect(found).not.toBeNull();
    });
  });
});
