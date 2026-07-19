import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresLedger } from '@epagoge/ledger';
import { buildServer } from '../src/server.js';
import { ensureLocalIdentity } from '../src/identity/local-key-store.js';

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

describeLive('Chat session persistence (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let token: string;

  async function register(): Promise<string> {
    const email = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Chat Tester' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().access_token as string;
  }

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();
    token = await register();
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it('upserts, lists, updates, and deletes a session', async () => {
    const id = randomUUID();

    // Create
    const put = await app.inject({
      method: 'PUT',
      url: `/chat/sessions/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'My first chat',
        entries: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(put.statusCode).toBe(200);

    // List — it's there, with entries preserved
    const list1 = await app.inject({
      method: 'GET',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list1.statusCode).toBe(200);
    const sessions1 = list1.json().sessions as Array<{
      id: string;
      title: string;
      entries: Array<{ role: string; content: string }>;
    }>;
    const mine = sessions1.find((s) => s.id === id);
    expect(mine).toBeDefined();
    expect(mine!.title).toBe('My first chat');
    expect(mine!.entries).toHaveLength(1);
    expect(mine!.entries[0]!.content).toBe('hello');

    // Update (same id) — title + entries change
    const put2 = await app.inject({
      method: 'PUT',
      url: `/chat/sessions/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Renamed',
        entries: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: 'hi there',
            frontierMeta: { provider: 'Anthropic', model: 'x' },
          },
        ],
      },
    });
    expect(put2.statusCode).toBe(200);
    const list2 = await app.inject({
      method: 'GET',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    const updated = (
      list2.json().sessions as Array<{ id: string; title: string; entries: unknown[] }>
    ).find((s) => s.id === id);
    expect(updated!.title).toBe('Renamed');
    expect(updated!.entries).toHaveLength(2);

    // Delete
    const del = await app.inject({
      method: 'DELETE',
      url: `/chat/sessions/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    const list3 = await app.inject({
      method: 'GET',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((list3.json().sessions as Array<{ id: string }>).some((s) => s.id === id)).toBe(false);
  });

  it("does not leak another user's sessions", async () => {
    const id = randomUUID();
    await app.inject({
      method: 'PUT',
      url: `/chat/sessions/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Private', entries: [{ role: 'user', content: 'secret' }] },
    });

    const otherToken = await register();
    const otherList = await app.inject({
      method: 'GET',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherList.statusCode).toBe(200);
    expect((otherList.json().sessions as Array<{ id: string }>).some((s) => s.id === id)).toBe(
      false,
    );
  });

  it('rejects a non-uuid id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/chat/sessions/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'x', entries: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('tokenless acts as the local owner (local-first)', async () => {
    expect((await app.inject({ method: 'GET', url: '/chat/sessions' })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/chat/sessions/${randomUUID()}` })).statusCode,
    ).not.toBe(401);
  });
});
