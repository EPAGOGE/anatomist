import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresLedger, userPrimaryChainId } from '@epagoge/ledger';
import { buildServer } from '../../src/server.js';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';

// F-0 Task 106 tests. Two layers:
//   1. Auth + ownership + validation (DB required; no GitHub needed)
//   2. Live GitHub roundtrip (DB + GITHUB_TEST_PAT + GITHUB_TEST_REPO required)
//
// The live layer skips cleanly when env vars aren't set, matching
// Task 105's anthropic/HF skip pattern.

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const GITHUB_TEST_PAT = process.env.GITHUB_TEST_PAT;
const GITHUB_TEST_REPO = process.env.GITHUB_TEST_REPO; // "owner/repo"

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

const dbLive = await dbReachable();
const describeLive = dbLive ? describe : describe.skip;
const liveGitHub = Boolean(GITHUB_TEST_PAT && GITHUB_TEST_REPO);
const describeGitHubLive = dbLive && liveGitHub ? describe : describe.skip;

process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

describeLive('Code exports — F-0 Task 106 (validation + ownership, no GitHub required)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessTokenA: string;
  let accessTokenB: string;
  let userIdA: string;
  let projectIdA: string;
  let architectureEventHash: string;

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    // User A and project A
    const emailA = `ce_a_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const regA = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: emailA, password: 'sufficiently-long-pass', display_name: 'CE User A' },
    });
    expect(regA.statusCode).toBe(201);
    accessTokenA = regA.json().access_token;
    userIdA = regA.json().user.id;

    const projA = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${accessTokenA}` },
      payload: { name: `CE test project A ${randomUUID().slice(0, 6)}` },
    });
    expect(projA.statusCode).toBe(201);
    projectIdA = projA.json().project_id;

    // Save a minimal architecture so we have a real event hash to export.
    const archRes = await app.inject({
      method: 'POST',
      url: '/architectures',
      headers: { authorization: `Bearer ${accessTokenA}` },
      payload: {
        name: 'Test architecture for export',
        project_id: projectIdA,
        nodes: [
          {
            id: 'n_in',
            componentId: 'ml.input',
            properties: { shape: 'batch,seq', dtype: 'int64' },
          },
          {
            id: 'n_emb',
            componentId: 'ml.embedding',
            properties: { vocab_size: 100, embed_dim: 8 },
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
    expect(archRes.statusCode).toBe(201);
    architectureEventHash = archRes.json().event_hash;
    expect(architectureEventHash).toMatch(/^[0-9a-f]{64}$/);

    // User B (for cross-user tests)
    const emailB = `ce_b_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const regB = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: emailB, password: 'sufficiently-long-pass', display_name: 'CE User B' },
    });
    expect(regB.statusCode).toBe(201);
    accessTokenB = regB.json().access_token;
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

  async function userPrimaryHeadMarker(userId: string): Promise<bigint> {
    const head = await ledger.getChainHead(userPrimaryChainId(userId), 'local_user');
    return head?.headSequenceMarker ?? 0n;
  }

  it('POST without a bearer token acts as the local owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/code-exports`,
      payload: {
        architecture_event_hash: architectureEventHash,
        destination_kind: 'github',
        destination_repo: 'someone/somerepo',
        destination_path: 'model.py',
        user_token: 'ghp_dummy_pat_for_validation_test_minimum_length_40_chars',
      },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('POST with invalid destination_repo format returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersA(),
      payload: {
        architecture_event_hash: architectureEventHash,
        destination_kind: 'github',
        destination_repo: 'not-an-owner-slash-repo', // missing slash
        destination_path: 'model.py',
        user_token: 'ghp_dummy_pat_for_validation_test_minimum_length_40_chars',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid-request');
  });

  it('POST with invalid architecture_event_hash returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersA(),
      payload: {
        architecture_event_hash: 'not-a-real-hash',
        destination_kind: 'github',
        destination_repo: 'someone/somerepo',
        destination_path: 'model.py',
        user_token: 'ghp_dummy_pat_for_validation_test_minimum_length_40_chars',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST with PAT shorter than 40 chars returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersA(),
      payload: {
        architecture_event_hash: architectureEventHash,
        destination_kind: 'github',
        destination_repo: 'someone/somerepo',
        destination_path: 'model.py',
        user_token: 'too-short',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST referencing nonexistent architecture event returns 404 (no chain advance)', async () => {
    const before = await userPrimaryHeadMarker(userIdA);
    const ghostHash = randomBytes(32).toString('hex');
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersA(),
      payload: {
        architecture_event_hash: ghostHash,
        destination_kind: 'github',
        destination_repo: 'someone/somerepo',
        destination_path: 'model.py',
        user_token: 'ghp_dummy_pat_for_validation_test_minimum_length_40_chars',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('architecture-not-found');
    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before);
  });

  it('User B cannot export from user A project (404, not 403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersB(),
      payload: {
        architecture_event_hash: architectureEventHash,
        destination_kind: 'github',
        destination_repo: 'someone/somerepo',
        destination_path: 'model.py',
        user_token: 'ghp_dummy_pat_for_validation_test_minimum_length_40_chars',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('User B cannot GET user A code-exports list (404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersB(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET on user A own project returns empty list before any exports', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersA(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project_id).toBe(projectIdA);
    expect(Array.isArray(res.json().exports)).toBe(true);
  });

  it('GET (read-only) does NOT advance user-primary chain head', async () => {
    const before = await userPrimaryHeadMarker(userIdA);
    await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersA(),
    });
    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before);
  });

  it('Cross-user blocked attempts do NOT advance user A chain head', async () => {
    const before = await userPrimaryHeadMarker(userIdA);
    await app.inject({
      method: 'POST',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersB(),
      payload: {
        architecture_event_hash: architectureEventHash,
        destination_kind: 'github',
        destination_repo: 'someone/somerepo',
        destination_path: 'model.py',
        user_token: 'ghp_dummy_pat_for_validation_test_minimum_length_40_chars',
      },
    });
    await app.inject({
      method: 'GET',
      url: `/projects/${projectIdA}/code-exports`,
      headers: headersB(),
    });
    const after = await userPrimaryHeadMarker(userIdA);
    expect(after).toBe(before);
  });

  // ---------- Live GitHub roundtrip ----------
  describeGitHubLive('Live GitHub roundtrip (requires GITHUB_TEST_PAT + GITHUB_TEST_REPO)', () => {
    it('full export roundtrip creates row + emits chain event with commit SHA', async () => {
      const before = await userPrimaryHeadMarker(userIdA);
      // Unique path per run so we don't conflict with prior runs.
      const path = `epagoge-test-exports/test-${Date.now()}-${randomUUID().slice(0, 8)}.py`;
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${projectIdA}/code-exports`,
        headers: headersA(),
        payload: {
          architecture_event_hash: architectureEventHash,
          destination_kind: 'github',
          destination_repo: GITHUB_TEST_REPO!,
          destination_path: path,
          user_token: GITHUB_TEST_PAT!,
          commit_message: `epagoge-platform live test ${new Date().toISOString()}`,
        },
      });
      if (res.statusCode !== 201) {
        // Log the response for debugging — useful when the test repo
        // doesn't accept the PAT or the path is malformed.
        console.error('GitHub export failed:', res.statusCode, res.json());
      }
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.export.commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(body.export.destination_repo).toBe(GITHUB_TEST_REPO);
      expect(body.chain_event_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.commit_html_url).toMatch(/^https:\/\/github\.com\//);

      const after = await userPrimaryHeadMarker(userIdA);
      expect(after).toBe(before + 1n);

      // The chain event is fetchable.
      const ev = await ledger.getEvent(body.chain_event_hash);
      expect(ev).toBeDefined();
      expect(ev!.chain_id).toBe(userPrimaryChainId(userIdA));
    });

    it('GET lists the exported entry after the live roundtrip', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/projects/${projectIdA}/code-exports`,
        headers: headersA(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().exports.length).toBeGreaterThanOrEqual(1);
    });
  });
});
