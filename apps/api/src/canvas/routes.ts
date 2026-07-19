// Canvas HTTP routes — architecture composition save / list / replay.
//
//   POST   /architectures               — save the current canvas state
//   GET    /architectures               — list this user's saves
//   GET    /architectures/:event_hash   — replay one save (returns the
//                                         full GraphSpec for the canvas
//                                         to hydrate)
//
// All three require an authenticated bearer token. Per-user chain
// (`architecture-composition:<user_uuid>`); routes scope by the JWT's
// `sub` claim and never accept a user id from the body or query.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createPostgresLedger } from '@epagoge/ledger';
import {
  ArchitectureNodeSchema,
  ArchitectureEdgeSchema,
  type ArchitectureCompositionPayload,
} from '@epagoge/shared';
import {
  ComponentRegistry,
  loadMlDomain,
  validateGraph,
  errorFingerprint,
  type ValidationError,
  type GraphSpec,
} from '@epagoge/components';
import { verifyToken, type JwtKey } from '../auth/jwt.js';
import type { LocalIdentity } from '../identity/local-key-store.js';
import {
  appendArchitectureEvent,
  ensureArchitectureChain,
  getUserArchitectureEvent,
  listUserArchitectureEvents,
} from './architecture-events.js';
import { appendCanvasSaveReasoning } from './reasoning-emit.js';
import { explainValidationError } from './explain-error.js';

export interface CanvasPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

// The save body matches the chain payload one-to-one EXCEPT
// architecture_id is optional on the wire — the server fills in a
// fresh UUID for first saves. Subsequent saves of the same logical
// architecture pass the existing id back so versions share lineage.
const SaveBodySchema = z.object({
  architecture_id: z.string().uuid().optional(),
  /** Project containing this architecture (F-0 Criterion 1). Optional
   *  on the wire so pre-F-0 saves still validate; new saves should
   *  scope to a project. */
  project_id: z.string().uuid().optional(),
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  nodes: z.array(ArchitectureNodeSchema),
  edges: z.array(ArchitectureEdgeSchema),
});

function requireBearer(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  jwtKey: JwtKey,
): { userId: string; sourceId: string } | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    // Local-first: no token means the local owner (see auth/local-user.ts).
    const local = request.server.localIdentity;
    if (local) return { userId: local.userId, sourceId: local.sourceId };
    reply.code(401).send({ error: { code: 'auth-required', message: 'bearer token required' } });
    return null;
  }
  const v = verifyToken(header.slice('Bearer '.length), jwtKey, { expectType: 'access' });
  if (!v.ok) {
    reply.code(401).send({ error: { code: 'invalid-token', message: 'token rejected' } });
    return null;
  }
  return { userId: v.claims.sub, sourceId: v.claims.sid };
}

export const canvasPlugin: FastifyPluginAsync<CanvasPluginOptions> = async (app, opts) => {
  // POST /architectures — save (or update — same endpoint either way).
  app.post('/architectures', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const parsed = SaveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid architecture save body',
          details: parsed.error.flatten(),
        },
      });
    }

    // Lazy-claim the chain (first save creates the ownership row).
    await ensureArchitectureChain(app.pool, auth.userId);

    const payload: ArchitectureCompositionPayload = {
      kind: 'architecture-saved',
      version: 1,
      architecture_id: parsed.data.architecture_id ?? randomUUID(),
      ...(parsed.data.project_id !== undefined ? { project_id: parsed.data.project_id } : {}),
      name: parsed.data.name,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
      occurred_at: new Date().toISOString(),
    };

    const ledger = createPostgresLedger({ pool: app.pool });
    try {
      const eventHash = await appendArchitectureEvent({
        ledger,
        identity: opts.platformIdentity,
        userId: auth.userId,
        payload,
      });

      // Read back the architecture event so we know its marker for the
      // reasoning record's decision_id. One ledger read, cheap.
      const archEvent = await ledger.getEvent(eventHash);
      const architectureMarker = archEvent?.causal_sequence_marker ?? 0n;

      // Emit the companion reasoning-capture event. Failure is logged
      // and bubbled up — per forward-design notes the reasoning event is
      // load-bearing, not optional, so a failure here MUST surface to
      // the caller rather than silently producing an
      // architecture-event-without-reasoning-companion state.
      let reasoningEventHash: string;
      try {
        reasoningEventHash = await appendCanvasSaveReasoning({
          ledger,
          identity: opts.platformIdentity,
          userId: auth.userId,
          architectureId: payload.architecture_id,
          architectureEventHash: eventHash,
          architectureMarker,
          name: payload.name,
          description: payload.description,
          nodeCount: payload.nodes.length,
          edgeCount: payload.edges.length,
          occurredAt: payload.occurred_at,
        });
      } catch (err) {
        app.log.error(
          { err, eventHash, userId: auth.userId },
          'reasoning-capture emission failed after architecture save',
        );
        return reply.code(500).send({
          error: {
            code: 'reasoning-emit-failed',
            message:
              'architecture event was signed but its reasoning-capture companion failed; manual reconciliation required',
            details: {
              architecture_event_hash: eventHash,
              architecture_id: payload.architecture_id,
            },
          },
        });
      }

      return reply.code(201).send({
        event_hash: eventHash,
        architecture_id: payload.architecture_id,
        name: payload.name,
        node_count: payload.nodes.length,
        edge_count: payload.edges.length,
        occurred_at: payload.occurred_at,
        reasoning_event_hash: reasoningEventHash,
      });
    } finally {
      await ledger.close();
    }
  });

  // GET /architectures — list this user's saves (chain walk).
  app.get<{ Querystring: { limit?: string } }>('/architectures', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50)));
    const ledger = createPostgresLedger({ pool: app.pool });
    try {
      const events = await listUserArchitectureEvents({
        ledger,
        userId: auth.userId,
        identity: opts.platformIdentity,
        limit,
      });
      // Hydrate each with the decoded payload for the list view. For
      // very long lists this could be a separate "summary" path that
      // skips payload decode; for Phase 0 sub-phase E (under 200
      // events per user) decoding everything is fine.
      const entries = await Promise.all(
        events.map(async (e) => {
          const detail = await getUserArchitectureEvent({
            ledger,
            userId: auth.userId,
            eventHash: e.eventHash,
          });
          return {
            event_hash: e.eventHash,
            causal_sequence_marker: e.causalSequenceMarker.toString(),
            architecture_id: detail?.payload.architecture_id ?? null,
            name: detail?.payload.name ?? '(undecodable)',
            description: detail?.payload.description ?? null,
            node_count: detail?.payload.nodes.length ?? 0,
            edge_count: detail?.payload.edges.length ?? 0,
            occurred_at: detail?.payload.occurred_at ?? null,
          };
        }),
      );
      return reply.send({
        user_id: auth.userId,
        architectures: entries,
      });
    } finally {
      await ledger.close();
    }
  });

  // GET /architectures/:event_hash — replay one save.
  app.get<{ Params: { event_hash: string } }>(
    '/architectures/:event_hash',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const hash = request.params.event_hash;
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid-hash', message: 'expected 64-char lowercase hex' } });
      }

      const ledger = createPostgresLedger({ pool: app.pool });
      try {
        const detail = await getUserArchitectureEvent({
          ledger,
          userId: auth.userId,
          eventHash: hash,
        });
        if (!detail) {
          return reply
            .code(404)
            .send({ error: { code: 'not-found', message: 'no such architecture event' } });
        }
        return reply.send({
          event_hash: hash,
          causal_sequence_marker: detail.causalSequenceMarker.toString(),
          payload: detail.payload,
        });
      } finally {
        await ledger.close();
      }
    },
  );

  // POST /architectures/validate — deterministic validation (tier 1).
  //
  // Server-side authority on whether a graph is valid. The frontend
  // runs its own copy of the same validator for snappy feedback, but
  // the server is the source of truth — never trust the client's
  // assertion about validity.
  app.post('/architectures/validate', async (request, reply) => {
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;
    const parsed = ValidateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid validate body',
          details: parsed.error.flatten(),
        },
      });
    }
    const registry = getCanvasRegistry();
    const graph: GraphSpec = {
      version: 1,
      name: parsed.data.name,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
    };
    const result = validateGraph(graph, registry);
    return reply.send({
      valid: result.valid,
      errors: result.errors.map((e) => ({
        ...e,
        fingerprint: errorFingerprint(e),
      })),
    });
  });

  // POST /architectures/explain-error — AI-assisted explanation (tier 2).
  //
  // The caller passes the FULL graph plus the fingerprint of the
  // specific error they want explained. The server re-runs validation
  // (defense in depth — don't trust the client's error claim) and
  // explains the matching error via the AI orchestrator.
  app.post('/architectures/explain-error', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;
    const parsed = ExplainBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid explain body',
          details: parsed.error.flatten(),
        },
      });
    }

    const registry = getCanvasRegistry();
    const graph: GraphSpec = {
      version: 1,
      name: parsed.data.name,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
    };
    const result = validateGraph(graph, registry);
    const target = (result.errors as readonly ValidationError[]).find(
      (e) => errorFingerprint(e) === parsed.data.fingerprint,
    );
    if (!target) {
      return reply.code(404).send({
        error: {
          code: 'no-such-error',
          message:
            'graph either is valid or does not contain the error fingerprint requested; reload validation and try again',
        },
      });
    }

    try {
      const explanation = await explainValidationError({
        pool: app.pool,
        platformIdentity: opts.platformIdentity,
        userId: auth.userId,
        sourceId: auth.sourceId,
        registry,
        error: target,
      });
      return reply.send({
        fingerprint: explanation.fingerprint,
        explanation: explanation.explanation,
        cost_nanos: explanation.costNanos.toString(),
        from_cache: explanation.fromCache,
        interaction_id: explanation.interactionId,
        ai_chain_event_hash: explanation.chainEventHash,
        tier: explanation.tier,
      });
    } catch (err) {
      app.log.error({ err, userId: auth.userId }, 'explain-error invocation failed');
      return reply.code(500).send({
        error: {
          code: 'explain-failed',
          message: 'AI explanation failed; the deterministic error description remains accurate',
        },
      });
    }
  });
};

// Validation + explain body schemas + registry singleton ----------------

const ValidateBodySchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  nodes: z.array(ArchitectureNodeSchema),
  edges: z.array(ArchitectureEdgeSchema),
});

const ExplainBodySchema = ValidateBodySchema.extend({
  fingerprint: z.string().min(1).max(256),
});

// Module-scoped registry — built once per process. The registry is
// immutable after loadMlDomain and reading is the hot path.
let _registry: ComponentRegistry | null = null;
function getCanvasRegistry(): ComponentRegistry {
  if (_registry) return _registry;
  const r = new ComponentRegistry();
  loadMlDomain(r);
  _registry = r;
  return r;
}
