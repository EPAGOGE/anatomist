import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import pg from 'pg';
import Redis from 'ioredis';
import { createPostgresLedger, type LedgerHandle } from '@epagoge/ledger';
import { env } from './env.js';
import { ensureLocalIdentity, type LocalIdentity } from './identity/local-key-store.js';
import { makeMasterKey } from './auth/master-key.js';
import { loadJwtKey } from './auth/jwt.js';
import { ensureLocalUser, loadProfile, resolveAuth } from './auth/local-user.js';
import { ensureAuthEventsChain } from './auth/auth-events.js';
import { registerPlugin } from './auth/routes/register.js';
import { loginPlugin } from './auth/routes/login.js';
import { refreshPlugin } from './auth/routes/refresh.js';
import { logoutPlugin } from './auth/routes/logout.js';
import { apiKeysPlugin } from './auth/routes/api-keys.js';
import { ensureAiInteractionChain } from './ai/ai-events.js';
import { chatPlugin } from './ai/routes/chat.js';
import { budgetPlugin } from './ai/routes/budget.js';
import { costStatsPlugin } from './ai/routes/cost-stats.js';
import { computePlugin } from './compute/routes.js';
import { explorerPlugin } from './chains/routes/explorer.js';
import { explainPlugin } from './chains/routes/explain.js';
import { exportPlugin } from './chains/routes/export.js';
import { searchPlugin } from './chains/routes/search.js';
import { pinsPlugin } from './chains/routes/pins.js';
import { auditPlugin } from './auth/routes/audit.js';
import { canvasPlugin } from './canvas/routes.js';
import { projectsPlugin } from './projects/routes.js';
import { datasetReferencesPlugin } from './dataset-references/routes.js';
import { codeExportsPlugin } from './code-exports/routes.js';
import { chatSessionsPlugin } from './chat-sessions/routes.js';

export interface ServerDeps {
  readonly pool?: pg.Pool;
  readonly redis?: Redis;
  readonly ledger?: LedgerHandle;
  readonly platformIdentity?: LocalIdentity;
}

export interface BuildServerOptions {
  /**
   * Pre-wired dependencies. When omitted, the server constructs its own based
   * on env. Tests pass mocks/in-memory variants here.
   */
  readonly deps?: ServerDeps;
  /**
   * Disable the auth routes (used by tests that don't need JWT/master keys).
   * Defaults to false in env's production mode and true otherwise iff
   * JWT_SECRET or MASTER_ENCRYPTION_KEY are absent.
   */
  readonly disableAuthRoutes?: boolean;
  /**
   * Skip the per-route rate limiters around /auth/register and /auth/login.
   * The global 100/min limit still applies. Tests set this so their loops
   * don't trip the 5/min/IP gate.
   */
  readonly disableAuthRateLimit?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: 'info' },
  });

  await app.register(helmet);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(cookie);

  const pool = options.deps?.pool;
  const redis = options.deps?.redis;
  const ledger = options.deps?.ledger;

  // Liveness: the process is up and Fastify can answer. No external checks.
  app.get('/health/live', async () => ({ status: 'ok' }));

  // Readiness: declare ready only when all configured dependencies are
  // reachable. Returns 503 with structured failure list when not.
  app.get('/health/ready', async (_request, reply) => {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    if (pool) {
      try {
        await pool.query('select 1');
        checks.push({ name: 'postgres', ok: true });
      } catch (err) {
        checks.push({
          name: 'postgres',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (redis) {
      try {
        const pong = await redis.ping();
        checks.push({
          name: 'redis',
          ok: pong === 'PONG',
          detail: pong === 'PONG' ? undefined : pong,
        });
      } catch (err) {
        checks.push({
          name: 'redis',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const allOk = checks.every((c) => c.ok);
    return reply.code(allOk ? 200 : 503).send({ status: allOk ? 'ready' : 'not-ready', checks });
  });

  // Legacy alias — preserved while callers migrate.
  app.get('/health', async () => ({ status: 'ok' }));

  // Decorate the app with the dependencies so route handlers can access them.
  if (pool) app.decorate('pool', pool);
  if (redis) app.decorate('redis', redis);
  if (ledger) app.decorate('ledger', ledger);

  // Auth routes. Mounted iff JWT_SECRET + MASTER_ENCRYPTION_KEY are
  // present AND a platform identity is available. Tests that pass
  // disableAuthRoutes: true skip this section.
  const wantAuth = !options.disableAuthRoutes && env.JWT_SECRET && env.MASTER_ENCRYPTION_KEY;
  if (wantAuth && pool && redis && options.deps?.platformIdentity) {
    const master = makeMasterKey(env.MASTER_ENCRYPTION_KEY);
    const jwtKey = loadJwtKey(env.JWT_SECRET);
    const platformIdentity = options.deps.platformIdentity;

    // Local-first: provision the owner identity once and decorate the app.
    // Routes fall back to this identity when no Bearer token is presented
    // (see auth/local-user.ts). Failure here is non-fatal — token auth
    // still works, and routes 401 without either.
    try {
      const localIdentity = await ensureLocalUser(pool, master);
      app.decorate('localIdentity', localIdentity);
      app.log.info({ userId: localIdentity.userId }, 'local owner identity ready');
    } catch (err) {
      app.log.error({ err }, 'failed to provision local owner identity');
    }

    // Who am I — resolves exactly like every other route (token or local
    // owner). The web app hydrates its identity store from this at boot.
    app.get('/me', async (request, reply) => {
      const auth = resolveAuth(request, reply, jwtKey);
      if (!auth) return;
      const profile = await loadProfile(pool, auth);
      if (!profile) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'user row missing' } });
      }
      return { user: profile };
    });

    // Per-route rate limits beyond the global 100/minute. Auth endpoints
    // are higher-value targets; tighten them. Tests pass
    // disableAuthRateLimit so their loops don't trip the 5/min/IP gate.
    await app.register(async (scope) => {
      if (!options.disableAuthRateLimit) {
        await scope.register(rateLimit, {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req) => `auth-write:${req.ip}`,
          addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
        });
      }
      await scope.register(registerPlugin, {
        master,
        jwtKey,
        jwtAccessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
        jwtRefreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
        platformIdentity,
      });
      await scope.register(loginPlugin, {
        jwtKey,
        jwtAccessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
        jwtRefreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
        platformIdentity,
      });
    });

    // Refresh, logout, api-keys live under the normal 100/min global limit.
    await app.register(refreshPlugin, {
      jwtKey,
      jwtAccessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      jwtRefreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
      platformIdentity,
    });
    await app.register(logoutPlugin, { jwtKey, platformIdentity });
    await app.register(apiKeysPlugin, { jwtKey, platformIdentity });

    // AI orchestration routes — auth-required, ride on top of the
    // existing JWT plumbing. ANTHROPIC_API_KEY presence is checked
    // lazily at first invocation, not at boot; the server can come up
    // without it and serve every non-/ai/* route.
    await app.register(chatPlugin, { jwtKey, platformIdentity });
    await app.register(budgetPlugin, { jwtKey });
    await app.register(costStatsPlugin, { jwtKey });

    // Compute control plane (platform gap #1): read-only GPU pricing + run
    // cost estimates, live from RunPod with reference fallback. No spend.
    await app.register(computePlugin, { jwtKey });

    // Chain Explorer — read-only HTTP surface over the chain
    // infrastructure. Authed via JWT; per-chain permissions enforced
    // via chain_owners in @epagoge/api/chains/permissions.
    await app.register(explorerPlugin, { jwtKey });
    // Chain event explanation — composes the AI orchestrator with the
    // chain explorer to make signed payloads human-readable on demand.
    await app.register(explainPlugin, { jwtKey, platformIdentity });
    // Verifiable cryptographic export — every readable chain in a
    // portable, signature-bearing bundle the user can hand to anyone.
    await app.register(exportPlugin, { jwtKey });
    // Reasoning-capture content search — makes the 26+ on-chain ADRs
    // discoverable by query. Phase 0 linear scan; index-backed later.
    await app.register(searchPlugin, { jwtKey });
    // Chain pinning + diff: user-scoped checkpoints. The "what's
    // changed since I last looked" pattern atop the append-only chain.
    await app.register(pinsPlugin, { jwtKey });
    // Per-user auth audit trail. Self-service security log.
    await app.register(auditPlugin, { jwtKey });
    // Canvas (Phase 0 sub-phase E): architecture-composition saves.
    // Each save lands a signed event on the per-user
    // architecture-composition:<user_uuid> chain.
    await app.register(canvasPlugin, { jwtKey, platformIdentity });
    // Projects (Phase 0 sub-phase F, F-0 Criterion 1): begin-a-project
    // flow plus lifecycle moves. Project creation and lifecycle
    // transitions emit signed events on the user-primary chain.
    await app.register(projectsPlugin, { jwtKey, platformIdentity });
    // Chat session persistence — durable, per-user Chat page conversations.
    // Plain UI state (no chain event); auth-required, owner-scoped rows.
    await app.register(chatSessionsPlugin, { jwtKey });
    // Dataset references (Phase 0 sub-phase F, F-0 Task 105): HF
    // dataset browsing + per-project reference recording. Each
    // dataset-referenced or -removed event lands on the user-primary
    // chain alongside project-lifecycle events. External HF calls
    // route through apps/api/src/external/ chokepoint.
    await app.register(datasetReferencesPlugin, { jwtKey, platformIdentity });

    // F-0 Task 106 — basic GitHub code export. POST /projects/:id/code-exports
    // pushes generated PyTorch code to a GitHub repo via user-supplied
    // PAT (rail-keeper #16: PAT is per-request, never persisted) and
    // emits a code-exported chain event with full provenance (architecture
    // event hash → external commit SHA). Read-only LIST endpoint also
    // included. All GitHub calls route through apps/api/src/external/
    // chokepoint (rail-keeper #11; rail-guard #21 lint-enforces).
    await app.register(codeExportsPlugin, { jwtKey, platformIdentity });

    // Idempotent claim of the auth-events and ai-interaction chains.
    await ensureAuthEventsChain(pool);
    await ensureAiInteractionChain(pool);
  }

  return app;
}

/**
 * Default wiring for the running api: constructs pool + Redis + ledger from
 * env, returns a server using them. The caller is responsible for closing
 * dependencies on shutdown.
 */
export async function buildDefaultServer(): Promise<{
  app: FastifyInstance;
  pool: pg.Pool;
  redis: Redis;
  ledger: LedgerHandle;
}> {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to construct the default server');
  }
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL);
  const ledger = createPostgresLedger({ pool });
  // Platform identity is the local hybrid keypair on disk. It signs system-
  // operational and auth-events chain writes. Phase 0 source_id convention:
  // 'local_user' (the same row seeded by db:seed; will diverge in Phase 2+
  // when platform vs user identities split).
  const { identity } = await ensureLocalIdentity('local_user');
  const app = await buildServer({
    deps: { pool, redis, ledger, platformIdentity: identity },
  });
  return { app, pool, redis, ledger };
}

declare module 'fastify' {
  interface FastifyInstance {
    pool?: pg.Pool;
    redis?: Redis;
    ledger?: LedgerHandle;
  }
}
