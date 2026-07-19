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

describeLive('Cost stats variants (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessToken: string;

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    const email = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Cost Tester' },
    });
    expect(reg.statusCode).toBe(201);
    accessToken = reg.json().access_token;
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it('default (no group_by) returns per-(model, tier, purpose) breakdown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ai/cost-stats',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.period_start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(body.breakdown)).toBe(true);
  });

  it('group_by=day returns daily aggregates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ai/cost-stats?group_by=day',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group_by).toBe('day');
    expect(Array.isArray(body.daily)).toBe(true);
    // No AI calls yet → empty daily array.
    expect(body.daily).toEqual([]);
  });

  it('group_by=feature returns per-feature aggregates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ai/cost-stats?group_by=feature',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group_by).toBe('feature');
    expect(Array.isArray(body.by_feature)).toBe(true);
  });

  it('tokenless acts as the local owner (local-first)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ai/cost-stats?group_by=day' });
    expect(res.statusCode).not.toBe(401);
  });
});
