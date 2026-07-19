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

describeLive('Architecture composition routes (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessToken: string;
  let userId: string;

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    const email = `arch_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Arch Tester' },
    });
    expect(reg.statusCode).toBe(201);
    const body = reg.json();
    accessToken = body.access_token;
    userId = body.user.id;
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  // The smallest valid graph: Input → Embedding → Output.
  const tinyGraph = () => ({
    name: 'Tiny',
    description: 'smallest valid composition',
    nodes: [
      { id: 'n_in', componentId: 'ml.input', properties: { shape: 'batch,seq', dtype: 'int64' } },
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
  });

  it('POST /architectures saves and returns an event_hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: tinyGraph(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.architecture_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('Tiny');
    expect(body.node_count).toBe(3);
    expect(body.edge_count).toBe(2);
    // Per E2-1: every save emits a companion reasoning-capture event.
    expect(body.reasoning_event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.reasoning_event_hash).not.toBe(body.event_hash);
  });

  it('save emits a reasoning-capture event that cross-references the architecture event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ...tinyGraph(), name: 'CrossRef Test' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const archHash = body.event_hash as string;
    const reasoningHash = body.reasoning_event_hash as string;

    // Read the reasoning event from the chain via the generic events endpoint.
    const reasoningEv = await app.inject({
      method: 'GET',
      url: `/events/${reasoningHash}?include_payload=true`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(reasoningEv.statusCode).toBe(200);
    const reasoningBody = reasoningEv.json();
    // Reasoning event lives on the reasoning-capture chain (not the
    // user's architecture-composition chain) — that's the cross-chain
    // half of the link.
    expect(reasoningBody.chain_id).toBe('reasoning-capture');
    expect(reasoningBody.event_type).toBe('user-generated');
    // causal_predecessors[1] (or [0] for the first reasoning event ever)
    // points at the architecture event we just created — the cross-chain
    // provenance pointer.
    expect(reasoningBody.causal_predecessors).toContain(archHash);
  });

  it('GET /architectures lists user saves with metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(userId);
    expect(Array.isArray(body.architectures)).toBe(true);
    expect(body.architectures.length).toBeGreaterThan(0);
    // Look up by name rather than index — earlier tests in this file
    // create additional saves, so "first" isn't necessarily "Tiny".
    const tiny = (
      body.architectures as Array<{ name: string; node_count: number; event_hash: string }>
    ).find((a) => a.name === 'Tiny');
    expect(tiny).toBeDefined();
    expect(tiny!.event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tiny!.node_count).toBe(3);
  });

  it('GET /architectures/:hash replays the full payload', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    // Find a "Tiny" save (other tests in this file create "CrossRef Test",
    // "Tiny v1", "Tiny v2"; look up by exact name).
    const tiny = (list.json().architectures as Array<{ name: string; event_hash: string }>).find(
      (a) => a.name === 'Tiny',
    );
    expect(tiny).toBeDefined();
    const eventHash = tiny!.event_hash;
    expect(eventHash).toMatch(/^[0-9a-f]{64}$/);

    const res = await app.inject({
      method: 'GET',
      url: `/architectures/${eventHash}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.event_hash).toBe(eventHash);
    expect(body.payload.kind).toBe('architecture-saved');
    expect(body.payload.version).toBe(1);
    expect(body.payload.name).toBe('Tiny');
    expect(body.payload.nodes).toHaveLength(3);
    expect(body.payload.edges).toHaveLength(2);
    // Nodes round-trip with the exact properties we sent.
    const embNode = body.payload.nodes.find(
      (n: { componentId: string }) => n.componentId === 'ml.embedding',
    );
    expect(embNode.properties.vocab_size).toBe(32000);
    expect(embNode.properties.embed_dim).toBe(512);
  });

  it('subsequent saves with the same architecture_id share lineage', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ...tinyGraph(), name: 'Tiny v1' },
    });
    const archId = first.json().architecture_id;

    const second = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ...tinyGraph(), name: 'Tiny v2', architecture_id: archId },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().architecture_id).toBe(archId);

    // Both events are on chain.
    const list = await app.inject({
      method: 'GET',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const matchingArchId = (list.json().architectures as Array<{ architecture_id: string }>).filter(
      (a) => a.architecture_id === archId,
    );
    expect(matchingArchId.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /architectures/:hash returns 404 for non-existent hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/architectures/${'0'.repeat(64)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /architectures/:hash returns 404 for another user's event", async () => {
    // Register a fresh user, save under them, then try to fetch with original token.
    const otherEmail = `arch2_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const otherReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: otherEmail,
        password: 'sufficiently-long-pass',
        display_name: 'Other',
      },
    });
    const otherToken = otherReg.json().access_token;
    const save = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: tinyGraph(),
    });
    const otherHash = save.json().event_hash;

    // First user tries to fetch it.
    const res = await app.inject({
      method: 'GET',
      url: `/architectures/${otherHash}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 on invalid body (missing nodes)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid-request');
  });

  it('tokenless acts as the local owner (local-first)', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/architectures', payload: tinyGraph() }))
        .statusCode,
    ).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/architectures' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/architectures/${'a'.repeat(64)}`,
        })
      ).statusCode,
    ).not.toBe(401);
  });
});
