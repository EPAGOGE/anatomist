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

describeLive('Chain pins + since-diff (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessToken: string;
  let earlyEventHash: string;
  let earlyEventMarker: bigint;

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
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Pin Tester' },
    });
    expect(reg.statusCode).toBe(201);
    accessToken = reg.json().access_token;

    // Pin target: an early auth-events event. Chosen because the chain is
    // guaranteed non-empty on ANY install — this very fixture's registration
    // just appended to it. (The old fixture pinned reasoning-capture, which
    // is only populated by the internal ADR backfill and is empty on a
    // fresh/public install.)
    const events = await app.inject({
      method: 'GET',
      url: '/chains/auth-events/events?limit=100',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const items = events.json().events as Array<{
      event_hash: string;
      causal_sequence_marker: string;
    }>;
    // Last in the walk = earliest (predecessor walk = head → genesis).
    const earliest = items[items.length - 1]!;
    earlyEventHash = earliest.event_hash;
    earlyEventMarker = BigInt(earliest.causal_sequence_marker);
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it('POST /chains/:id/pins creates a pin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chains/auth-events/pins',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { event_hash: earlyEventHash, label: 'my checkpoint' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.event_hash).toBe(earlyEventHash);
    expect(body.label).toBe('my checkpoint');
  });

  it('POST /chains/:id/pins is idempotent (returns existing)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chains/auth-events/pins',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { event_hash: earlyEventHash },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().already_pinned).toBe(true);
  });

  it('POST /chains/:id/pins 404 on non-existent event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chains/auth-events/pins',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { event_hash: '0'.repeat(64) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /chains/:id/pins 400 when event is on a different chain', async () => {
    // earlyEventHash lives on auth-events; pinning it onto ai-interaction
    // (a different platform chain) must be rejected as wrong-chain.
    const res = await app.inject({
      method: 'POST',
      url: '/chains/ai-interaction/pins',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { event_hash: earlyEventHash },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('wrong-chain');
  });

  it("GET /chains/:id/pins lists this user's pins", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/auth-events/pins',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const pins = res.json().pins as Array<{ event_hash: string }>;
    expect(pins.some((p) => p.event_hash === earlyEventHash)).toBe(true);
  });

  it('GET /chains/:id/events?since=<hash> returns only events after the pin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/chains/auth-events/events?since=${earlyEventHash}&limit=100`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.since_marker).toBe(earlyEventMarker.toString());
    // Every event returned should have a higher marker than the pin.
    for (const ev of body.events as Array<{ causal_sequence_marker: string }>) {
      expect(BigInt(ev.causal_sequence_marker) > earlyEventMarker).toBe(true);
    }
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('DELETE /chains/:id/pins/:pin_id removes the pin', async () => {
    // Find the pin id from the listing.
    const list = await app.inject({
      method: 'GET',
      url: '/chains/auth-events/pins',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const pin = (list.json().pins as Array<{ id: string; event_hash: string }>).find(
      (p) => p.event_hash === earlyEventHash,
    );
    expect(pin).toBeDefined();

    const del = await app.inject({
      method: 'DELETE',
      url: `/chains/auth-events/pins/${pin!.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const list2 = await app.inject({
      method: 'GET',
      url: '/chains/auth-events/pins',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const pins = list2.json().pins as Array<{ event_hash: string }>;
    expect(pins.find((p) => p.event_hash === earlyEventHash)).toBeUndefined();
  });

  it('pin/list/delete all tokenless acts as the local owner (local-first)', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/chains/auth-events/pins',
      payload: { event_hash: earlyEventHash },
    });
    expect(post.statusCode).not.toBe(401);

    const get = await app.inject({ method: 'GET', url: '/chains/auth-events/pins' });
    expect(get.statusCode).not.toBe(401);
  });
});
