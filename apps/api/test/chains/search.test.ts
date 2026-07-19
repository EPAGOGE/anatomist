// Reasoning chain search — covers /chains/reasoning-capture/search.

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

describeLive('Reasoning chain search (live)', () => {
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
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Search Tester' },
    });
    expect(reg.statusCode).toBe(201);
    accessToken = reg.json().access_token;

    // Self-seed searchable content: a canvas save emits a reasoning-capture
    // record whose summary carries the architecture NAME and whose reasoning
    // carries the DESCRIPTION. (The old fixture searched ADR content that only
    // the internal backfill provides — empty on a fresh/public install.)
    const save = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Zephyrine Probe Array',
        description: 'Routing study for the argonaut lattice: measure per-head routing entropy.',
        nodes: [
          {
            id: 'n_in',
            componentId: 'ml.input',
            properties: { shape: 'batch,seq', dtype: 'int64' },
          },
          {
            id: 'n_emb',
            componentId: 'ml.embedding',
            properties: { vocab_size: 32000, embed_dim: 512 },
          },
          { id: 'n_out', componentId: 'ml.output', properties: {} },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'n_in', portId: 'out' },
            target: { nodeId: 'n_emb', portId: 'tokens' },
          },
          {
            id: 'e2',
            source: { nodeId: 'n_emb', portId: 'out' },
            target: { nodeId: 'n_out', portId: 'in' },
          },
        ],
      },
    });
    expect(save.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it('finds records by content match in decision_summary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/search?q=zephyrine',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits.length).toBeGreaterThan(0);
    // The seeded canvas save carries 'Zephyrine' in its decision_summary.
    const seeded = body.hits.find((h: { decision_id: string }) =>
      h.decision_id.startsWith('CANVAS-'),
    );
    expect(seeded).toBeDefined();
    expect(seeded.matched_in).toContain('summary');
  });

  it('finds records by content match in reasoning text', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/search?q=argonaut',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json().hits as Array<{ decision_id: string }>;
    expect(hits.find((h) => h.decision_id.startsWith('CANVAS-'))).toBeDefined();
  });

  it('returns empty hits for a non-matching query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/search?q=this-string-cannot-possibly-match',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toEqual([]);
  });

  it('rejects queries shorter than 2 chars', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/search?q=a',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('tokenless acts as the local owner (local-first)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/search?q=routing',
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('respects limit parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/search?q=chain&limit=2',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits.length).toBeLessThanOrEqual(2);
  });

  it('returns a snippet containing the query term', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/search?q=Argonaut',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const hit = (res.json().hits as Array<{ snippet: string }>)[0];
    expect(hit).toBeDefined();
    expect(hit.snippet.toLowerCase()).toContain('argonaut');
  });
});
