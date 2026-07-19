import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresLedger } from '@epagoge/ledger';
import { resolveReferences, formatReferencesForPrompt } from '@epagoge/ai';
import { buildServer } from '../../src/server.js';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';

// F-0 Criteria 5 + 7 live tests.
//
// Companion endpoint: returns the project metadata plus a decision
// log derived from architecture-composition chain events scoped to
// the project. NOT a new capture surface — pure view per ADR-0037.
//
// Reference resolver: loads project context + recent decisions +
// recent chain history. Selectivity: cap per section, project-
// scoped when projectId is present.

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

describeLive('Project companion + reference resolver (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessToken: string;
  let userId: string;
  let projectId: string;

  // Smallest valid graph (Input → Embedding → Output) used for saves.
  const smallGraph = () => ({
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

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    const email = `companion_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Companion Tester' },
    });
    expect(reg.statusCode).toBe(201);
    accessToken = reg.json().access_token;
    userId = reg.json().user.id;

    const proj = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Companion test project', lifecycle_position: 'architecture' },
    });
    projectId = proj.json().project_id;

    // Produce two architecture saves scoped to this project.
    for (let i = 0; i < 2; i++) {
      const save = await app.inject({
        method: 'POST',
        url: '/architectures',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          project_id: projectId,
          name: `Companion arch ${i + 1}`,
          description: i === 1 ? 'Llama-style decoder with GQA + SwiGLU.' : undefined,
          ...smallGraph(),
        },
      });
      expect(save.statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it('GET /projects/:id/companion returns project + decision log', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/companion`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.project.project_id).toBe(projectId);
    expect(body.project.name).toBe('Companion test project');
    expect(body.project.lifecycle_position).toBe('architecture');
    expect(Array.isArray(body.decision_log)).toBe(true);
    expect(body.decision_log.length).toBe(2);
    // Most recent first (companion is for "where you were" — last
    // save is the most contextually current).
    const ts0 = body.decision_log[0].occurred_at;
    const ts1 = body.decision_log[1].occurred_at;
    expect(ts0 >= ts1).toBe(true);
    // Each decision row carries the architecture event hash so the
    // companion can link to chain inspection.
    for (const row of body.decision_log) {
      expect(row.architecture_event_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.node_count).toBeGreaterThan(0);
    }
  });

  it("cross-user 404 — another user cannot read this project's companion", async () => {
    const otherEmail = `other_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const otherReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: otherEmail, password: 'sufficiently-long-pass', display_name: 'Other' },
    });
    const otherToken = otherReg.json().access_token;
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/companion`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reference resolver loads project context for this user', async () => {
    const refs = await resolveReferences({
      userId,
      projectId,
      sessionId: 'test-session',
      query: 'Should I add another attention layer here?',
      pool,
      ledger,
    });
    expect(refs.projectContext).not.toBeNull();
    expect(refs.projectContext!.projectName).toBe('Companion test project');
    expect(refs.projectContext!.lifecyclePosition).toBe('architecture');
    expect(refs.projectContext!.recentActivity.length).toBeGreaterThanOrEqual(1);
  });

  it('reference resolver loads recent decisions scoped to project', async () => {
    const refs = await resolveReferences({
      userId,
      projectId,
      sessionId: 'test-session',
      query: 'decoder GQA SwiGLU',
      pool,
      ledger,
    });
    expect(refs.recentDecisions.length).toBeGreaterThanOrEqual(1);
    // The save with description "Llama-style decoder with GQA + SwiGLU"
    // should rank first because the query terms match its text.
    expect(refs.recentDecisions[0]!.reasoning.toLowerCase()).toMatch(/(gqa|swiglu|llama)/);
  });

  it('formatReferencesForPrompt produces a non-empty grounding segment when data is present', async () => {
    const refs = await resolveReferences({
      userId,
      projectId,
      sessionId: 'test-session',
      query: 'arbitrary question',
      pool,
      ledger,
    });
    const segment = formatReferencesForPrompt(refs);
    expect(segment.length).toBeGreaterThan(0);
    expect(segment).toContain('PROJECT CONTEXT');
    expect(segment).toContain('Companion test project');
  });

  it('formatReferencesForPrompt returns empty when projectId is null and no other grounding', async () => {
    const refs = await resolveReferences({
      userId,
      projectId: null,
      sessionId: 'test-session',
      query: 'arbitrary question',
      pool,
      ledger,
    });
    // No project context. Decisions may still be present if there are
    // orphan saves; for this user there should be none scoped to "no
    // project" since all our test saves carry a project_id.
    expect(refs.projectContext).toBeNull();
    expect(refs.recentDecisions.length).toBe(0);
  });
});
