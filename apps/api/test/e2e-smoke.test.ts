// End-to-end smoke test. Exercises the full user-facing pipeline as a
// single sequence:
//
//   1. register → 201 with tokens + chain genesis hash
//   2. login   → 200 with new tokens
//   3. GET /chains → user can see platform-owned chains + their own
//   4. GET /chains/reasoning-capture → head info exists
//   5. GET /chains/reasoning-capture/events → first page of events
//   6. GET /events/:hash → single event detail
//   7. GET /export/me → bundle includes the user's own chain
//   8. POST /events/:hash/explain → skipped without ANTHROPIC_API_KEY
//
// One regression check that gates the entire HTTP surface. If anything
// upstream changes the request/response shape between these endpoints,
// this test catches it before manual demo.

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

describeLive('End-to-end smoke (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

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
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it('full pipeline: register → chains → events → export', async () => {
    // 1. Register
    const email = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Smoke' },
    });
    expect(reg.statusCode).toBe(201);
    const regBody = reg.json();
    expect(regBody.user.email).toBe(email);
    expect(regBody.user.chain_id).toMatch(/^user-primary:/);
    expect(regBody.user.genesis_event_hash).toMatch(/^[0-9a-f]{64}$/);

    const userChainId = regBody.user.chain_id as string;
    const genesisHash = regBody.user.genesis_event_hash as string;
    const accessToken = regBody.access_token as string;

    // 2. Login produces a fresh refresh-token family (access tokens
    //    issued in the same second are identical — deterministic HS256
    //    over same claims — so we compare refresh tokens which carry
    //    unique jti per family).
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'sufficiently-long-pass' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().refresh_token).not.toBe(regBody.refresh_token);

    // 3. /chains shows platform-owned + own user-primary
    const chainsRes = await app.inject({
      method: 'GET',
      url: '/chains',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(chainsRes.statusCode).toBe(200);
    const chains = chainsRes.json().chains as Array<{ chain_id: string }>;
    const chainIds = chains.map((c) => c.chain_id);
    expect(chainIds).toContain('reasoning-capture');
    expect(chainIds).toContain('system-operational');
    expect(chainIds).toContain('auth-events');
    expect(chainIds).toContain('ai-interaction');
    expect(chainIds).toContain(userChainId);

    // 4. Seed the reasoning-capture chain through the product itself: a
    // canvas save emits a reasoning record. (The old assertion required the
    // internal ADR backfill's 26 records — empty on a fresh install.)
    const save = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Smoke Pipeline',
        description: 'e2e smoke: seed one reasoning record',
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

    const headRes = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(headRes.statusCode).toBe(200);
    const headBody = headRes.json();
    expect(headBody.head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(headBody.event_count_total)).toBeGreaterThanOrEqual(1);

    // 5. /chains/reasoning-capture/events first page
    const eventsRes = await app.inject({
      method: 'GET',
      url: '/chains/reasoning-capture/events?limit=5',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(eventsRes.statusCode).toBe(200);
    const events = eventsRes.json().events as Array<{ event_hash: string }>;
    // Fresh installs have only the records the product itself has emitted so
    // far (at least our step-4 save); page size caps at the requested limit.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(5);

    // 6. /events/:hash returns the user's genesis event detail
    const genesisRes = await app.inject({
      method: 'GET',
      url: `/events/${genesisHash}?include_payload=true`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(genesisRes.statusCode).toBe(200);
    const genesis = genesisRes.json();
    expect(genesis.event_hash).toBe(genesisHash);
    expect(genesis.chain_id).toBe(userChainId);
    expect(genesis.causal_predecessors).toEqual([]);
    expect(typeof genesis.payload_base64).toBe('string');

    // 7. /export/me includes the user's own chain
    const exportRes = await app.inject({
      method: 'GET',
      url: '/export/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(exportRes.statusCode).toBe(200);
    const bundle = exportRes.json();
    expect(bundle.bundle_version).toBe(1);
    const userChain = (bundle.chains as Array<{ chain_id: string; events: unknown[] }>).find(
      (c) => c.chain_id === userChainId,
    );
    expect(userChain).toBeDefined();
    expect((userChain!.events as Array<{ event_hash: string }>)[0]?.event_hash).toBe(genesisHash);

    // 8. Explain endpoint — actually runs against Anthropic when key
    // is present. Skip silently otherwise; the smoke is still useful
    // up to step 7 without AI.
    if (process.env.ANTHROPIC_API_KEY) {
      const explainRes = await app.inject({
        method: 'POST',
        url: `/events/${genesisHash}/explain`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { tier: 'haiku' },
      });
      expect(explainRes.statusCode).toBe(200);
      const explanation = explainRes.json();
      expect(typeof explanation.explanation).toBe('string');
      expect(explanation.explanation.length).toBeGreaterThan(20);
      expect(explanation.ai_interaction.chain_event_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
