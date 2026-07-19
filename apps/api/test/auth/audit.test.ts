import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresLedger } from '@epagoge/ledger';
import { buildServer } from '../../src/server.js';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';

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

process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

describeLive('Per-user auth audit (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessToken: string;
  let myEmail: string;

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    myEmail = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: myEmail, password: 'sufficiently-long-pass', display_name: 'Audit Tester' },
    });
    expect(reg.statusCode).toBe(201);
    accessToken = reg.json().access_token;

    // Generate one more auth event for this user — a fresh login.
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: myEmail, password: 'sufficiently-long-pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it("GET /auth/audit returns the user's own auth events", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/audit?limit=20',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    // At minimum: one auth-registration + one auth-login.
    const kinds = (body.entries as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('auth-registration');
    expect(kinds).toContain('auth-login');
  });

  it('audit events carry occurred_at + event_hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/audit',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const entries = res.json().entries as Array<{
      event_hash: string;
      occurred_at: string;
      kind: string;
    }>;
    for (const e of entries) {
      expect(e.event_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(e.kind).toMatch(/^auth-/);
    }
  });

  it("audit does NOT include other users' events", async () => {
    // Register a SECOND user, then a third trigger event for THAT user.
    const otherEmail = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: otherEmail,
        password: 'sufficiently-long-pass',
        display_name: 'Other',
      },
    });

    // Read the first user's audit; it should NOT contain the other user's email.
    const res = await app.inject({
      method: 'GET',
      url: '/auth/audit?limit=50',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const entries = res.json().entries as Array<Record<string, unknown>>;
    // Nothing in entries should reference otherEmail.
    for (const e of entries) {
      expect(JSON.stringify(e)).not.toContain(otherEmail);
    }
  });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/audit' });
    expect(res.statusCode).toBe(401);
  });
});
