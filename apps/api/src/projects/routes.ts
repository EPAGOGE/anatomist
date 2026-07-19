// Project HTTP routes — F-0 Criterion 1 (ADR-0036).
//
//   POST   /projects                   — create
//   GET    /projects                   — list (this user's projects)
//   GET    /projects/:project_id       — detail
//   PATCH  /projects/:project_id/lifecycle  — move lifecycle position
//
// Per ADR-0036, project creation and lifecycle changes emit signed
// events on the user-primary chain. Every write here is one row
// insert + one chain event, with bidirectional reference via the
// projects.creation_event_hash column.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import {
  architectureCompositionChainId,
  computeEventHash,
  createPostgresLedger,
} from '@epagoge/ledger';
import {
  decodeCbor,
  LIFECYCLE_POSITIONS,
  type LifecyclePosition,
  type ProjectCreatedPayload,
  type ProjectLifecycleUpdatedPayload,
} from '@epagoge/shared';
import { verifyToken, type JwtKey } from '../auth/jwt.js';
import type { LocalIdentity } from '../identity/local-key-store.js';
import { projects } from '../db/schema.js';
import { appendProjectCreated, appendProjectLifecycleUpdated } from './project-events.js';

export interface ProjectsPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

const LifecyclePositionSchema = z.enum(LIFECYCLE_POSITIONS);

const CreateBodySchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  lifecycle_position: LifecyclePositionSchema.optional(),
});

const UpdateLifecycleBodySchema = z.object({
  new_position: LifecyclePositionSchema,
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

export const projectsPlugin: FastifyPluginAsync<ProjectsPluginOptions> = async (app, opts) => {
  // POST /projects — begin a project.
  //
  // The project-created event lands on the user-primary chain before
  // the row insert so the row can hold a verified pointer back to
  // its creation event. If the chain append fails the row is never
  // written.
  app.post('/projects', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const parsed = CreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid create-project body',
          details: parsed.error.flatten(),
        },
      });
    }

    const projectId = crypto.randomUUID();
    const lifecycle: LifecyclePosition = parsed.data.lifecycle_position ?? 'architecture';
    const occurredAt = new Date().toISOString();

    const payload: ProjectCreatedPayload = {
      kind: 'project-created',
      version: 1,
      project_id: projectId,
      name: parsed.data.name,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      lifecycle_position: lifecycle,
      occurred_at: occurredAt,
    };

    const ledger = createPostgresLedger({ pool: app.pool });
    let eventHash: string;
    try {
      eventHash = await appendProjectCreated({
        ledger,
        identity: opts.platformIdentity,
        userId: auth.userId,
        payload,
      });
    } catch (err) {
      await ledger.close();
      app.log.error({ err, userId: auth.userId }, 'project-created chain append failed');
      return reply.code(500).send({
        error: {
          code: 'chain-append-failed',
          message: 'project creation aborted before any state was written',
        },
      });
    }
    await ledger.close();

    // Insert the row with the verified pointer.
    const db = drizzle(app.pool);
    try {
      await db.insert(projects).values({
        id: projectId,
        ownerUserId: auth.userId,
        name: parsed.data.name,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        lifecyclePosition: lifecycle,
        creationEventHash: eventHash,
      });
    } catch (err) {
      app.log.error(
        { err, projectId, eventHash, userId: auth.userId },
        'project row insert failed AFTER chain event — manual reconciliation needed',
      );
      return reply.code(500).send({
        error: {
          code: 'row-insert-failed',
          message: 'project event signed on chain but row insert failed; reconciliation required',
          details: { project_id: projectId, creation_event_hash: eventHash },
        },
      });
    }

    return reply.code(201).send({
      project_id: projectId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      lifecycle_position: lifecycle,
      creation_event_hash: eventHash,
      occurred_at: occurredAt,
    });
  });

  // GET /projects — list the user's projects (newest first).
  app.get<{ Querystring: { limit?: string } }>('/projects', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50)));
    const db = drizzle(app.pool);
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.ownerUserId, auth.userId))
      .orderBy(desc(projects.createdAt))
      .limit(limit);

    return reply.send({
      user_id: auth.userId,
      projects: rows.map((r) => ({
        project_id: r.id,
        name: r.name,
        description: r.description,
        lifecycle_position: r.lifecyclePosition,
        creation_event_hash: r.creationEventHash,
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
      })),
    });
  });

  // GET /projects/:project_id — detail.
  app.get<{ Params: { project_id: string } }>('/projects/:project_id', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const id = request.params.project_id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid-id', message: 'project_id must be a UUID' } });
    }
    const db = drizzle(app.pool);
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerUserId, auth.userId)))
      .limit(1);
    if (rows.length === 0) {
      // 404 with no detail — do not leak whether the id exists under
      // a different owner.
      return reply.code(404).send({ error: { code: 'not-found', message: 'no such project' } });
    }
    const r = rows[0]!;
    return reply.send({
      project_id: r.id,
      name: r.name,
      description: r.description,
      lifecycle_position: r.lifecyclePosition,
      creation_event_hash: r.creationEventHash,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    });
  });

  // PATCH /projects/:project_id/lifecycle — move the lifecycle position.
  app.patch<{ Params: { project_id: string } }>(
    '/projects/:project_id/lifecycle',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const id = request.params.project_id;
      const parsed = UpdateLifecycleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'invalid-request',
            message: 'invalid lifecycle update body',
            details: parsed.error.flatten(),
          },
        });
      }

      const db = drizzle(app.pool);
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.ownerUserId, auth.userId)))
        .limit(1);
      if (rows.length === 0) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'no such project' } });
      }
      const current = rows[0]!;
      if (current.lifecyclePosition === parsed.data.new_position) {
        return reply
          .code(200)
          .send({ project_id: id, lifecycle_position: current.lifecyclePosition });
      }

      const occurredAt = new Date().toISOString();
      const payload: ProjectLifecycleUpdatedPayload = {
        kind: 'project-lifecycle-updated',
        version: 1,
        project_id: id,
        previous_position: current.lifecyclePosition as LifecyclePosition,
        new_position: parsed.data.new_position,
        occurred_at: occurredAt,
      };

      const ledger = createPostgresLedger({ pool: app.pool });
      let eventHash: string;
      try {
        eventHash = await appendProjectLifecycleUpdated({
          ledger,
          identity: opts.platformIdentity,
          userId: auth.userId,
          payload,
        });
      } catch (err) {
        await ledger.close();
        app.log.error({ err, projectId: id, userId: auth.userId }, 'lifecycle event append failed');
        return reply.code(500).send({
          error: {
            code: 'chain-append-failed',
            message: 'lifecycle update aborted; row unchanged',
          },
        });
      }
      await ledger.close();

      await db
        .update(projects)
        .set({ lifecyclePosition: parsed.data.new_position, updatedAt: new Date() })
        .where(eq(projects.id, id));

      return reply.send({
        project_id: id,
        previous_position: current.lifecyclePosition,
        new_position: parsed.data.new_position,
        lifecycle_event_hash: eventHash,
        occurred_at: occurredAt,
      });
    },
  );

  // GET /projects/:project_id/companion — F-0 Criterion 7.
  //
  // The companion is a VIEW over existing chain data (per ADR-0037):
  // it does NOT capture new decisions. Returns the project's current
  // state plus a decision log distilled from the architecture-
  // composition events on chain that carry this project's id.
  //
  // What the user sees here is "where you were" — the orientation
  // that lets them resume after time away instead of reconstructing.
  app.get<{ Params: { project_id: string } }>(
    '/projects/:project_id/companion',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const id = request.params.project_id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid-id', message: 'project_id must be a UUID' } });
      }
      const db = drizzle(app.pool);
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.ownerUserId, auth.userId)))
        .limit(1);
      if (rows.length === 0) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'no such project' } });
      }
      const project = rows[0]!;

      // Walk the user's architecture-composition chain backward from
      // head and collect this project's saves (decoding payloads to
      // filter by project_id). Cap to a reasonable window so the
      // companion stays responsive.
      const ledger = createPostgresLedger({ pool: app.pool });
      const decisionLog: Array<{
        architecture_id: string;
        architecture_event_hash: string;
        name: string;
        description: string | null;
        node_count: number;
        edge_count: number;
        occurred_at: string;
        causal_sequence_marker: string;
      }> = [];
      try {
        const archChainId = architectureCompositionChainId(auth.userId);
        const head = await ledger.getChainHead(archChainId, 'local_user');
        if (head) {
          let walked = 0;
          for await (const event of ledger.walkPredecessors(head.headHash, { maxDepth: 80 })) {
            if (walked++ > 80) break;
            if (event.chain_id !== archChainId) continue;
            const eventHash = computeEventHash(event);
            const payloadBytes = await ledger.getEventPayload(eventHash);
            if (!payloadBytes) continue;
            let decoded: Record<string, unknown> | null = null;
            try {
              const raw = decodeCbor(payloadBytes);
              if (raw && typeof raw === 'object') decoded = raw as Record<string, unknown>;
            } catch {
              continue;
            }
            if (!decoded) continue;
            if (decoded.project_id !== id) continue;
            decisionLog.push({
              architecture_id: String(decoded.architecture_id ?? ''),
              architecture_event_hash: eventHash,
              name: String(decoded.name ?? ''),
              description: typeof decoded.description === 'string' ? decoded.description : null,
              node_count: Array.isArray(decoded.nodes) ? decoded.nodes.length : 0,
              edge_count: Array.isArray(decoded.edges) ? decoded.edges.length : 0,
              occurred_at: String(decoded.occurred_at ?? ''),
              causal_sequence_marker: String(event.causal_sequence_marker),
            });
            if (decisionLog.length >= 40) break;
          }
        }
      } finally {
        await ledger.close();
      }

      return reply.send({
        project: {
          project_id: project.id,
          name: project.name,
          description: project.description,
          lifecycle_position: project.lifecyclePosition,
          creation_event_hash: project.creationEventHash,
          created_at: project.createdAt.toISOString(),
          updated_at: project.updatedAt.toISOString(),
        },
        decision_log: decisionLog,
      });
    },
  );
};
