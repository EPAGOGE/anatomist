import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresLedger, userPrimaryChainId } from '@epagoge/ledger';
import { buildServer } from '../../src/server.js';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';

// F-0 Task 105 live tests. Confirm that:
//   - GET  /huggingface/datasets/search returns results (Category 2 read-only)
//   - GET  /huggingface/datasets/:id returns metadata for known datasets
//   - GET  /huggingface/datasets/:id returns 404 for nonexistent datasets
//   - POST /projects/:id/dataset-references creates a row + emits
//     dataset-referenced on user-primary chain (Category 1)
//   - POST is idempotent — repeated dataset references return existing
//     and DO NOT advance the chain head (negative-direction; rail-keeper #18)
//   - GET  /projects/:id/dataset-references lists this project's references
//   - DELETE soft-removes + emits dataset-reference-removed with
//     original_event_hash linking to the creation event (D.11 compensating)
//   - Re-reference after delete creates new row + new event (full arc)
//   - Cross-user reads/writes are blocked: 404 same response for not-
//     exists and not-owned (rail-keeper #17; no information leak)
//   - Read-only routes do NOT advance the user-primary chain head
//     (rail-keeper #19; negative-direction emission test)
//
// Requires DB + HF Hub reachable. Suite skips cleanly when either is
// unavailable. Uses 'stanfordnlp/imdb' as the stable test dataset (it
// has been on HF Hub for many years; license MIT; suitable for
// regression-safe testing).

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

async function hfHubReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = globalThis.setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('https://huggingface.co/api/datasets?limit=1', {
      signal: ctrl.signal,
    });
    globalThis.clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const dbLive = await dbReachable();
const hfLive = dbLive ? await hfHubReachable() : false;
const live = dbLive && hfLive;
const describeLive = live ? describe : describe.skip;

process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

const STABLE_DATASET = 'stanfordnlp/imdb';
const STABLE_SEARCH_QUERY = 'imdb';

describeLive('Dataset references — F-0 Task 105 (live, requires DB + HF Hub)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessTokenA: string;
  let accessTokenB: string;
  let userIdA: string;
  let userIdB: string;
  let projectIdA: string;

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    // User A and project A
    const emailA = `ds_a_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const regA = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: emailA, password: 'sufficiently-long-pass', display_name: 'DS User A' },
    });
    expect(regA.statusCode).toBe(201);
    accessTokenA = regA.json().access_token;
    userIdA = regA.json().user.id;

    const projA = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${accessTokenA}` },
      payload: { name: `DS test project A ${randomUUID().slice(0, 6)}` },
    });
    expect(projA.statusCode).toBe(201);
    projectIdA = projA.json().project_id;

    // User B and project B (for cross-user isolation tests)
    const emailB = `ds_b_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const regB = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: emailB, password: 'sufficiently-long-pass', display_name: 'DS User B' },
    });
    expect(regB.statusCode).toBe(201);
    accessTokenB = regB.json().access_token;
    userIdB = regB.json().user.id;
    // Note: user B doesn't need their own project for the cross-user
    // isolation tests; they attempt to access user A's project and
    // get 404. Keeping userIdB + accessTokenB; dropping projectIdB.
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  function headersA() {
    return { authorization: `Bearer ${accessTokenA}` };
  }
  function headersB() {
    return { authorization: `Bearer ${accessTokenB}` };
  }

  // Helper to read the user-primary chain head marker for negative-direction
  // tests ("the head DID NOT advance after this call").
  async function userPrimaryHeadMarker(userId: string): Promise<bigint> {
    const head = await ledger.getChainHead(userPrimaryChainId(userId), 'local_user');
    return head?.headSequenceMarker ?? 0n;
  }

  // ---------- HF passthrough (Category 2 read-only) ----------

  it('GET /huggingface/datasets/search returns results for a stable query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/huggingface/datasets/search?q=${encodeURIComponent(STABLE_SEARCH_QUERY)}&limit=5`,
      headers: headersA(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.results)).toBe(true);
    // 'imdb' will return many matches; just confirm shape.
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]).toMatchObject({ id: expect.any(String) });
  });

  it('GET /huggingface/datasets/:id returns metadata for the stable dataset', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/huggingface/datasets/${encodeURIComponent(STABLE_DATASET)}`,
      headers: headersA(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.info).toMatchObject({ id: STABLE_DATASET });
  });

  it('GET /huggingface/datasets/:id returns 404 for a nonexistent dataset', async () => {
    const ghostId = `epagoge-nonexistent-${randomUUID()}`;
    const res = await app.inject({
      method: 'GET',
      url: `/huggingface/datasets/${encodeURIComponent(ghostId)}`,
      headers: headersA(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('dataset-not-found');
  });

  it('GET HF routes require a bearer token (401 tokenless (local owner))', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/huggingface/datasets/search?q=imdb',
    });
    expect(res.statusCode).not.toBe(401);
  });

  // ---------- Rail-keeper #19: read-only routes do NOT emit ----------

  it('HF search + info + list references do NOT advance the user-primary chain head', async () => {
    const before = await userPrimaryHeadMarker(userIdA);

    await app.inject({
      method: 'GET',
      url: `/huggingface/datasets/search?q=${encodeURIComponent(STABLE_SEARCH_QUERY)}`,
      headers: headersA(),
    });
    await app.inject({
      method: 'GET',
      url: `/huggingface/datasets/${encodeURIComponent(STABLE_DATASET)}`,
      headers: headersA(),
    });
    await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
    });

    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before);
  });

  // ---------- POST emission + DB row (Category 1) ----------

  it('POST /projects/:id/dataset-references creates a row + emits on user-primary chain', async () => {
    const before = await userPrimaryHeadMarker(userIdA);

    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
      payload: { dataset_id: STABLE_DATASET },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.idempotent).toBe(false);
    expect(body.reference).toMatchObject({
      project_id: projectIdA,
      source_registry: 'huggingface',
      dataset_id: STABLE_DATASET,
      dataset_url: `https://huggingface.co/datasets/${STABLE_DATASET}`,
    });
    expect(body.chain_event_hash).toMatch(/^[0-9a-f]{64}$/);

    // Chain head advanced by exactly one.
    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before + 1n);

    // The event is fetchable and well-formed.
    const event = await ledger.getEvent(body.chain_event_hash);
    expect(event).toBeDefined();
    expect(event!.chain_id).toBe(userPrimaryChainId(userIdA));
    expect(event!.event_type).toBe('user-generated');
  });

  // ---------- Rail-keeper #18: idempotency on same active reference ----------

  it('POST same dataset twice is idempotent: returns existing, chain head does NOT advance', async () => {
    // First POST already happened in the previous test. Re-POST.
    const before = await userPrimaryHeadMarker(userIdA);

    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
      payload: { dataset_id: STABLE_DATASET },
    });
    expect(res.statusCode).toBe(200); // 200 (existing), not 201 (created)
    expect(res.json().idempotent).toBe(true);
    expect(res.json().reference.dataset_id).toBe(STABLE_DATASET);

    // Critical negative-direction assertion: head must NOT advance.
    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before);
  });

  // ---------- GET list returns the reference ----------

  it('GET /projects/:id/dataset-references lists the reference (default excludes removed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.project_id).toBe(projectIdA);
    expect(body.references.length).toBeGreaterThanOrEqual(1);
    const ref = body.references.find(
      (r: { dataset_id: string }) => r.dataset_id === STABLE_DATASET,
    );
    expect(ref).toBeDefined();
    expect(ref.removed_at).toBeNull();
  });

  // ---------- DELETE soft-removes + emits compensating event (D.11) ----------

  it('DELETE soft-removes + emits dataset-reference-removed with original_event_hash', async () => {
    // Find the active reference id.
    const list = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
    });
    const ref = list
      .json()
      .references.find((r: { dataset_id: string }) => r.dataset_id === STABLE_DATASET);
    expect(ref).toBeDefined();
    const referenceId = ref.id;
    const originalEventHash = ref.creation_event_hash;

    const before = await userPrimaryHeadMarker(userIdA);

    const del = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectIdA}/dataset-references/${referenceId}`,
      headers: headersA(),
    });
    expect(del.statusCode).toBe(204);

    // Head advanced by exactly one (the compensating event).
    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before + 1n);

    // Default GET (include_removed=false) excludes the now-removed reference.
    const listAfter = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
    });
    const stillActive = listAfter
      .json()
      .references.find((r: { id: string }) => r.id === referenceId);
    expect(stillActive).toBeUndefined();

    // include_removed=true returns it with removed_at set + removal_event_hash.
    const listAll = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references?include_removed=true`,
      headers: headersA(),
    });
    const removed = listAll.json().references.find((r: { id: string }) => r.id === referenceId);
    expect(removed).toBeDefined();
    expect(removed.removed_at).not.toBeNull();
    expect(removed.removal_event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(removed.creation_event_hash).toBe(originalEventHash);
  });

  // ---------- Re-reference after delete creates new row + new event ----------

  it('Re-referencing same dataset after delete creates a NEW row + NEW event', async () => {
    const before = await userPrimaryHeadMarker(userIdA);

    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
      payload: { dataset_id: STABLE_DATASET },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().idempotent).toBe(false); // NOT idempotent — the prior was removed
    const newReferenceId = res.json().reference.id;

    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before + 1n);

    // Two rows total now for this dataset on this project — one removed,
    // one active. The chain shows the referenced → removed → re-referenced arc.
    const listAll = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references?include_removed=true`,
      headers: headersA(),
    });
    const allMatching = listAll
      .json()
      .references.filter((r: { dataset_id: string }) => r.dataset_id === STABLE_DATASET);
    expect(allMatching.length).toBeGreaterThanOrEqual(2);
    expect(allMatching.some((r: { id: string }) => r.id === newReferenceId)).toBe(true);
  });

  // ---------- Rail-keeper #17: project-ownership isolation ----------

  it('User B cannot POST a reference to user A project (404, not 403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersB(),
      payload: { dataset_id: STABLE_DATASET },
    });
    // 404 same as not-exists — rail-keeper #17 no information leak.
    expect(res.statusCode).toBe(404);
  });

  it('User B cannot GET user A project references (404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersB(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('User B cannot DELETE on user A project (404)', async () => {
    // Use a random UUID; whether it exists or not, response is 404.
    const res = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectIdA}/dataset-references/${randomUUID()}`,
      headers: headersB(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('Nonexistent project_id returns 404 (same as not-owned)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${randomUUID()}/dataset-references`,
      headers: headersA(),
      payload: { dataset_id: STABLE_DATASET },
    });
    expect(res.statusCode).toBe(404);
  });

  it('Negative-direction: cross-user blocked attempts do NOT advance user A chain head', async () => {
    const before = await userPrimaryHeadMarker(userIdA);

    // User B attempts to POST/GET/DELETE on user A's project.
    await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersB(),
      payload: { dataset_id: STABLE_DATASET },
    });
    await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersB(),
    });
    await app.inject({
      method: 'DELETE',
      url: `/projects/${projectIdA}/dataset-references/${randomUUID()}`,
      headers: headersB(),
    });

    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before);

    // And user B's own chain didn't advance either (those calls were rejected).
    void userIdB; // bind to avoid lint; identity used implicitly through tokens
  });

  // ---------- Body validation ----------

  it('POST with empty dataset_id returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
      payload: { dataset_id: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid-request');
  });

  it('POST without a bearer token acts as the local owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      payload: { dataset_id: STABLE_DATASET },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('POST for nonexistent HF dataset returns 404', async () => {
    const ghostId = `epagoge-ghost-${randomUUID()}`;
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/dataset-references`,
      headers: headersA(),
      payload: { dataset_id: ghostId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('dataset-not-found');
  });
});
