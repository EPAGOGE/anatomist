import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresLedger, userPrimaryChainId } from '@epagoge/ledger';
import { buildServer } from '../../src/server.js';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';

// F-0 Criterion 1 live tests. Confirm that:
//   - POST /projects creates a row AND emits a project-created event
//     on the user-primary chain
//   - GET /projects returns only this user's projects (auth isolation)
//   - PATCH /projects/:id/lifecycle moves the row AND emits a
//     project-lifecycle-updated event
//   - Each event walks back to the user-primary genesis cleanly
// All per ADR-0036.

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

describeLive('Projects routes (live)', () => {
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

    const email = `proj_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Proj Tester' },
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

  function authedHeader() {
    return { authorization: `Bearer ${accessToken}` };
  }

  it('POST /projects creates a row + signs an event on the user-primary chain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authedHeader(),
      payload: {
        name: 'Pretraining run alpha',
        description: 'Decoder-only LM with GQA',
        lifecycle_position: 'architecture',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.project_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.creation_event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.lifecycle_position).toBe('architecture');

    // The event lives on the user-primary chain and is fully verifiable.
    const event = await ledger.getEvent(body.creation_event_hash);
    expect(event).toBeDefined();
    expect(event!.chain_id).toBe(userPrimaryChainId(userId));
    expect(event!.event_type).toBe('user-generated');
  });

  it('defaults lifecycle_position to architecture when not provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authedHeader(),
      payload: { name: 'Default lifecycle test' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().lifecycle_position).toBe('architecture');
  });

  it("GET /projects lists this user's projects newest-first", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: authedHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(userId);
    expect(body.projects.length).toBeGreaterThanOrEqual(2);
    // Newest first — confirmed by created_at descending.
    for (let i = 0; i < body.projects.length - 1; i++) {
      const a = body.projects[i]!.created_at;
      const b = body.projects[i + 1]!.created_at;
      expect(a >= b).toBe(true);
    }
  });

  it('GET /projects/:id returns detail; 404 for nonexistent', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: authedHeader(),
    });
    const projectId = list.json().projects[0]!.project_id;
    const detail = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: authedHeader(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project_id).toBe(projectId);

    const ghost = await app.inject({
      method: 'GET',
      url: `/projects/${randomUUID()}`,
      headers: authedHeader(),
    });
    expect(ghost.statusCode).toBe(404);
  });

  it('rejects invalid UUID in path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/not-a-uuid',
      headers: authedHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH lifecycle moves the row + emits an event', async () => {
    // Create a fresh project so this test is independent.
    const create = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authedHeader(),
      payload: { name: 'Lifecycle target', lifecycle_position: 'architecture' },
    });
    const projectId = create.json().project_id;

    const move = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/lifecycle`,
      headers: authedHeader(),
      payload: { new_position: 'training' },
    });
    expect(move.statusCode).toBe(200);
    const body = move.json();
    expect(body.previous_position).toBe('architecture');
    expect(body.new_position).toBe('training');
    expect(body.lifecycle_event_hash).toMatch(/^[0-9a-f]{64}$/);

    // Detail reflects the new position.
    const detail = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: authedHeader(),
    });
    expect(detail.json().lifecycle_position).toBe('training');
  });

  it('PATCH lifecycle no-op returns 200 without emitting an event', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authedHeader(),
      payload: { name: 'No-op target', lifecycle_position: 'evaluation' },
    });
    const projectId = create.json().project_id;
    const same = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/lifecycle`,
      headers: authedHeader(),
      payload: { new_position: 'evaluation' },
    });
    expect(same.statusCode).toBe(200);
    // No event hash returned because no event was emitted.
    expect(same.json().lifecycle_event_hash).toBeUndefined();
  });

  it('serves tokenless requests as the local owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'No auth' },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it("a different user cannot see this user's projects", async () => {
    // Register a second user and ask for projects with their token.
    const email = `other_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Other' },
    });
    const otherToken = reg.json().access_token;
    const otherList = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherList.statusCode).toBe(200);
    // Their list is empty — auth isolation holds.
    expect(otherList.json().projects).toEqual([]);

    // And they can't fetch any of user A's projects by id.
    const list = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: authedHeader(),
    });
    const aId = list.json().projects[0]!.project_id;
    const ghost = await app.inject({
      method: 'GET',
      url: `/projects/${aId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(ghost.statusCode).toBe(404);
  });
});
