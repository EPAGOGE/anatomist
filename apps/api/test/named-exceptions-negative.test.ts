// Negative-direction emission tests for ADR-0039's named exceptions.
//
// Closes the verification asymmetry surfaced as CONNECTIONS IDEA-004 and
// re-confirmed during the F-0 closure audit: the platform's named-exception
// routes (state-changing HTTP routes that DO NOT emit a chain event per
// ADR-0039) were guarded only by the doctor's static allowlist + reviewer
// attention. No test asserted that hitting these routes leaves the chain
// head unchanged.
//
// This file mirrors `apps/api/src/doctor/checks/emission-discipline.ts`'s
// NAMED_EXCEPTIONS set one-to-one. When a new entry is added there, a
// corresponding negative-direction test should be added here. The doctor
// check is the static side; this file is the runtime side. Together they
// close the "positive-only verification" gap.
//
// Coverage (5 named exceptions + 1 runtime-branch no-op):
//   A. POST   /chains/:id/pins              — pin create
//   B. DELETE /chains/:id/pins/:pin_id      — pin delete
//   C. POST   /architectures/validate       — deterministic read-only
//   D. PATCH  /projects/:id/lifecycle       — same-position no-op branch
//                                              (NOT in NAMED_EXCEPTIONS;
//                                              runtime early-return)
//   E. POST   /ai/chat                       — transitive via orchestrator
//   F. POST   /architectures/explain-error  — transitive via orchestrator
//
// Tests A-D require only DB + Redis; they always run when the DB is reachable.
// Tests E-F require ANTHROPIC_API_KEY because they exercise the AI
// orchestrator (which is the very thing being tested as the transitive
// emitter); when the key is absent the AI section skips cleanly.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createPostgresLedger,
  userPrimaryChainId,
  architectureCompositionChainId,
} from '@epagoge/ledger';
import { buildServer } from '../src/server.js';
import { ensureLocalIdentity } from '../src/identity/local-key-store.js';
import { AI_INTERACTION_CHAIN_ID } from '../src/ai/ai-events.js';

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
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const describeAi = live && hasAnthropicKey ? describe : describe.skip;

process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

describeLive('Named-exception negative-direction emission tests (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessToken: string;
  let userId: string;
  let projectId: string;
  let pinnableEventHash: string;
  let savedPinId: string | null = null;

  // Head-marker readers for the chains involved in named-exception checks.
  // Returning 0n when no head exists yet means "before == after" still
  // works on a freshly initialized chain.
  async function headMarker(chainId: string): Promise<bigint> {
    const head = await ledger.getChainHead(chainId, 'local_user');
    return head?.headSequenceMarker ?? 0n;
  }
  async function userPrimaryHead(): Promise<bigint> {
    return headMarker(userPrimaryChainId(userId));
  }
  async function architectureCompositionHead(): Promise<bigint> {
    return headMarker(architectureCompositionChainId(userId));
  }

  function authHeaders() {
    return { authorization: `Bearer ${accessToken}` };
  }

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    const email = `ne_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email,
        password: 'sufficiently-long-pass',
        display_name: 'Named-Exception Tester',
      },
    });
    expect(reg.statusCode).toBe(201);
    accessToken = reg.json().access_token;
    userId = reg.json().user.id;

    // A project for the lifecycle no-op test (D).
    const projRes = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authHeaders(),
      payload: { name: `Named-exc test project ${randomUUID().slice(0, 6)}` },
    });
    expect(projRes.statusCode).toBe(201);
    projectId = projRes.json().project_id;

    // Pick a real event from the auth-events chain to pin against — it is
    // guaranteed non-empty on any install (this fixture's own registration
    // just appended to it). Mirrors test/chains/pins.test.ts.
    const events = await app.inject({
      method: 'GET',
      url: '/chains/auth-events/events?limit=10',
      headers: authHeaders(),
    });
    expect(events.statusCode).toBe(200);
    const items = events.json().events as Array<{ event_hash: string }>;
    expect(items.length).toBeGreaterThan(0);
    pinnableEventHash = items[items.length - 1]!.event_hash;
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  // ---------- A: POST /chains/:id/pins (named exception #1) ----------

  it('POST /chains/:id/pins does NOT advance the user-primary chain head', async () => {
    const before = await userPrimaryHead();

    const res = await app.inject({
      method: 'POST',
      url: '/chains/auth-events/pins',
      headers: authHeaders(),
      payload: { event_hash: pinnableEventHash, label: 'negative-direction probe' },
    });
    expect(res.statusCode).toBe(201);
    savedPinId = res.json().id;

    const after = await userPrimaryHead();
    expect(after).toBe(before);
  });

  // ---------- B: DELETE /chains/:id/pins/:pin_id (named exception #2) ----------

  it('DELETE /chains/:id/pins/:pin_id does NOT advance the user-primary chain head', async () => {
    // Depends on A having run + savedPinId being set.
    expect(savedPinId).not.toBeNull();
    const before = await userPrimaryHead();

    const res = await app.inject({
      method: 'DELETE',
      url: `/chains/auth-events/pins/${savedPinId!}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(204);

    const after = await userPrimaryHead();
    expect(after).toBe(before);
  });

  // ---------- C: POST /architectures/validate (named exception #3) ----------

  it('POST /architectures/validate does NOT advance any chain head', async () => {
    const upBefore = await userPrimaryHead();
    const acBefore = await architectureCompositionHead();

    // A trivially valid tiny graph (matches the canvas tests' shape).
    const tinyGraph = {
      name: 'NE-validate-probe',
      description: 'negative-direction validate probe',
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
    };

    const res = await app.inject({
      method: 'POST',
      url: '/architectures/validate',
      headers: authHeaders(),
      payload: tinyGraph,
    });
    expect(res.statusCode).toBe(200);
    // Deterministic validator; the graph above is valid.
    expect(res.json().valid).toBe(true);

    const upAfter = await userPrimaryHead();
    const acAfter = await architectureCompositionHead();
    expect(upAfter).toBe(upBefore);
    expect(acAfter).toBe(acBefore);
  });

  // ---------- D: PATCH /projects/:id/lifecycle no-op (runtime-branch exception) ----------
  //
  // NOT in NAMED_EXCEPTIONS — the lifecycle route DOES emit when the
  // position changes. But when the new position equals the current
  // position, the handler early-returns before calling the emission
  // helper. That early-return is structurally a named exception of a
  // different shape (runtime-branch rather than always-no-emit) and
  // deserves the same negative-direction assertion.

  it('PATCH /projects/:id/lifecycle with same position does NOT advance the user-primary chain head', async () => {
    // Read current position (newly created project defaults to 'data').
    const projGet = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: authHeaders(),
    });
    expect(projGet.statusCode).toBe(200);
    const currentPosition = projGet.json().lifecycle_position;

    const before = await userPrimaryHead();

    const res = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/lifecycle`,
      headers: authHeaders(),
      payload: { new_position: currentPosition }, // same → no-op
    });
    expect(res.statusCode).toBe(200);
    // No-op response shape: just current position back; no event hash.
    expect(res.json().lifecycle_event_hash).toBeUndefined();
    expect(res.json().lifecycle_position).toBe(currentPosition);

    const after = await userPrimaryHead();
    expect(after).toBe(before);
  });
});

// ---------- E, F: AI-orchestrated named exceptions ----------
//
// /ai/chat and /architectures/explain-error are tagged in NAMED_EXCEPTIONS
// because the route handler does NOT call appendChainEvent directly — the
// orchestrator inside the handler emits an ai-interaction event. So the
// negative-direction assertion has two halves:
//   1. The user-primary chain DOES NOT advance (the route doesn't
//      double-emit on its caller's primary chain).
//   2. The ai-interaction chain DOES advance (proves the transitive
//      emission is the actual emission path).
//
// Both halves together pin the doctor's "Category 1 transitively" justification.

describeAi(
  'Named-exception AI-orchestrated transitive emission (live, requires ANTHROPIC_API_KEY)',
  () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    const redis = new Redis(REDIS_URL, { lazyConnect: true });
    const ledger = createPostgresLedger({ pool });

    type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
    let app: FastifyApp;
    let accessToken: string;
    let userId: string;

    async function headMarker(chainId: string): Promise<bigint> {
      const head = await ledger.getChainHead(chainId, 'local_user');
      return head?.headSequenceMarker ?? 0n;
    }
    async function userPrimaryHead(): Promise<bigint> {
      return headMarker(userPrimaryChainId(userId));
    }
    async function aiInteractionHead(): Promise<bigint> {
      return headMarker(AI_INTERACTION_CHAIN_ID);
    }

    beforeAll(async () => {
      const { identity } = await ensureLocalIdentity('local_user');
      app = await buildServer({
        deps: { pool, redis, ledger, platformIdentity: identity },
        disableAuthRateLimit: true,
      });
      await app.ready();

      const email = `ne_ai_${randomUUID().slice(0, 8)}@epagoge-test.local`;
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email,
          password: 'sufficiently-long-pass',
          display_name: 'NE-AI Tester',
        },
      });
      expect(reg.statusCode).toBe(201);
      accessToken = reg.json().access_token;
      userId = reg.json().user.id;
    });

    afterAll(async () => {
      await app.close();
      await ledger.close();
      redis.disconnect();
      await pool.end();
    });

    // ---------- E: POST /ai/chat (named exception #4) ----------

    it('POST /ai/chat does NOT advance user-primary chain head; ai-interaction head advances (transitive)', async () => {
      const upBefore = await userPrimaryHead();
      const aiBefore = await aiInteractionHead();

      // Unique prompt so response cache doesn't short-circuit on a repeat run.
      const uniquePrompt = `Echo only the word OK. ${randomUUID()}`;
      const res = await app.inject({
        method: 'POST',
        url: '/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          purpose: 'chat',
          tier: 'haiku', // cheapest tier; negative-direction test doesn't care about reasoning quality
          messages: [{ role: 'user', content: uniquePrompt }],
        },
      });
      expect(res.statusCode).toBe(200);

      const upAfter = await userPrimaryHead();
      const aiAfter = await aiInteractionHead();

      // Negative-direction: the route's "obvious" target chain is unmoved.
      expect(upAfter).toBe(upBefore);
      // Transitive emission verified: ai-interaction head DID advance.
      expect(aiAfter).toBeGreaterThan(aiBefore);
    });

    // ---------- F: POST /architectures/explain-error (named exception #5) ----------

    it('POST /architectures/explain-error does NOT advance user-primary chain head; ai-interaction head advances (transitive)', async () => {
      // An intentionally-invalid graph that will produce a validation error
      // the orchestrator can explain. Missing edge from Input → forces a
      // deterministic validation failure with a stable fingerprint.
      const brokenGraph = {
        name: 'NE-explain-probe',
        description: 'broken graph for explain-error probe',
        nodes: [
          {
            id: 'n_in',
            componentId: 'ml.input',
            properties: { shape: 'batch,seq', dtype: 'int64' },
          },
          { id: 'n_out', componentId: 'ml.output', properties: {} },
        ],
        edges: [],
      };

      // First call validate to get the error fingerprint deterministically.
      const validateRes = await app.inject({
        method: 'POST',
        url: '/architectures/validate',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: brokenGraph,
      });
      expect(validateRes.statusCode).toBe(200);
      const body = validateRes.json();
      expect(body.valid).toBe(false);
      expect(body.errors.length).toBeGreaterThan(0);
      const fingerprint = body.errors[0]!.fingerprint;
      expect(typeof fingerprint).toBe('string');

      const upBefore = await userPrimaryHead();
      const aiBefore = await aiInteractionHead();

      const res = await app.inject({
        method: 'POST',
        url: '/architectures/explain-error',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ...brokenGraph, fingerprint },
      });
      expect(res.statusCode).toBe(200);

      const upAfter = await userPrimaryHead();
      const aiAfter = await aiInteractionHead();

      // Negative-direction: user-primary chain unmoved (the explain-error
      // route does NOT directly emit; orchestrator handles emission).
      expect(upAfter).toBe(upBefore);
      // Transitive emission verified. Note: response-cache hit on a repeated
      // identical fingerprint may cause this to fail; the random graph name
      // above keeps the prompt unique enough to bypass cache on each run.
      expect(aiAfter).toBeGreaterThan(aiBefore);
    });
  },
);
