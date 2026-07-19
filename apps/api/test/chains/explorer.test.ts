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

// Fresh env keys per run so we don't collide with other suites.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

describeLive('Chain Explorer endpoints (live)', () => {
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

    // Register a user to get a bearer token. The explorer endpoints
    // require auth.
    const email = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Explorer' },
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

  it('GET /chains returns chains the user can read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.chains)).toBe(true);
    const ids = body.chains.map((c: { chain_id: string }) => c.chain_id);
    // Platform-owned chains should be visible.
    expect(ids).toContain('reasoning-capture');
    expect(ids).toContain('system-operational');
    // The user's own user-primary chain should be visible.
    expect(ids.some((id: string) => id.startsWith('user-primary:'))).toBe(true);
  });

  it('GET /chains tokenless acts as the local owner (local-first)', async () => {
    const res = await app.inject({ method: 'GET', url: '/chains' });
    expect(res.statusCode).not.toBe(401);
  });

  it('GET /chains/:id returns head info for reasoning-capture', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chain_id).toBe('reasoning-capture');
    expect(body.owner_type).toBe('platform');
    expect(body.head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(body.event_count_total)).toBeGreaterThan(0);
  });

  it('GET /chains/:id returns 404 for unknown chain', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/not-a-real-chain',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /chains/:id returns 403 for another user's chain", async () => {
    // Register a second user, then try to read THEIR user-primary chain.
    const otherEmail = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const otherReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: otherEmail, password: 'sufficiently-long-pass', display_name: 'Other' },
    });
    expect(otherReg.statusCode).toBe(201);
    const otherChainId = otherReg.json().user.chain_id as string;

    // Use the FIRST user's token to try to read the SECOND user's chain.
    const res = await app.inject({
      method: 'GET',
      url: `/chains/${encodeURIComponent(otherChainId)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /chains/reasoning-capture/events returns paginated events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/events?limit=5',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(5);
    for (const ev of body.events) {
      expect(ev.event_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(ev.chain_id).toBe('reasoning-capture');
      // The reasoning-capture chain hosts BOTH 'system-operational'
      // ADRs (the platform's own architectural decisions) AND
      // 'user-generated' canvas-save reasoning records (per E2-1).
      // Either is valid on this chain.
      expect(['system-operational', 'user-generated']).toContain(ev.event_type);
    }
    expect(body.next_before_marker).not.toBeNull();
  });

  it('GET /chains/:id/events paginates via before_marker', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/events?limit=3',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const firstBody = first.json();
    expect(firstBody.events).toHaveLength(3);
    const cursor = firstBody.next_before_marker;
    expect(cursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/chains/reasoning-capture/events?limit=3&before_marker=${cursor}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const secondBody = second.json();
    expect(secondBody.events.length).toBeGreaterThan(0);
    // No overlap: every second-page marker must be < cursor.
    const cursorBig = BigInt(cursor);
    for (const ev of secondBody.events) {
      expect(BigInt(ev.causal_sequence_marker) < cursorBig).toBe(true);
    }
  });

  it('GET /events/:hash returns event detail for a known event', async () => {
    // Get an event hash from the chain head.
    const head = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const headHash = head.json().head_hash as string;

    const res = await app.inject({
      method: 'GET',
      url: `/events/${headHash}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.event_hash).toBe(headHash);
    expect(body.chain_id).toBe('reasoning-capture');
    expect(body.payload_integrity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET /events/:hash?include_payload=true returns base64 payload', async () => {
    const head = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const headHash = head.json().head_hash as string;

    const res = await app.inject({
      method: 'GET',
      url: `/events/${headHash}?include_payload=true`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.payload_base64).toBeTruthy();
    expect(Number(body.payload_size_bytes)).toBeGreaterThan(0);
  });

  it('GET /events/:hash returns 400 on malformed hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/events/not-a-hash',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /events/:hash returns 404 on unknown hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/events/${'0'.repeat(64)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
