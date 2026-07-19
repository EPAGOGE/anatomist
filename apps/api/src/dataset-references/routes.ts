// Dataset reference HTTP routes — F-0 Task 105 (HF dataset browsing, basic).
//
//   GET    /huggingface/datasets/search?q=...&limit=...&offset=...
//   GET    /huggingface/datasets/:dataset_id
//   POST   /projects/:project_id/dataset-references
//   GET    /projects/:project_id/dataset-references[?include_removed=true]
//   DELETE /projects/:project_id/dataset-references/:reference_id
//
// Scope governor (build doc): "basic" — browse and reference. NO
// download, NO hosting. The platform records a project's intent to
// use a dataset; the dataset content stays on the registry.
//
// Active rail-keepers honored here:
//   #11 External-API chokepoint  — all HF calls via apps/api/src/external/
//   #14 Schema-first design       — payloads landed before this file
//   #15 Emission classification   — tagged at the HF chokepoint call sites
//   #16 User-scoped credentials   — HF token is per-user, never platform-wide
//   #17 Project-ownership assert  — every mutation gated on ownership
//   #18 Idempotency on same-state — re-reference of active = return existing
//   #19 Named-exception negative tests — covered in routes.test.ts

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createPostgresLedger } from '@epagoge/ledger';
import type { DatasetReferencedPayload, DatasetReferenceRemovedPayload } from '@epagoge/shared';
import { verifyToken, type JwtKey } from '../auth/jwt.js';
import type { LocalIdentity } from '../identity/local-key-store.js';
import { projects, projectDatasetReferences } from '../db/schema.js';
import {
  appendDatasetReferenced,
  appendDatasetReferenceRemoved,
} from '../projects/project-events.js';
import {
  searchDatasets,
  getDatasetInfo,
  deriveDatasetUrl,
  deriveDatasetName,
  deriveLicense,
  deriveTaskType,
} from '../external/huggingface.js';
import { ExternalFetchError } from '../external/http.js';

export interface DatasetReferencesPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

// ---- request schemas ----

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateReferenceBodySchema = z.object({
  dataset_id: z.string().min(1).max(255),
  /** Optional user-supplied HF token for higher rate limits. Per rail-keeper #16. */
  user_token: z.string().min(1).max(512).optional(),
});

// ---- auth helper (mirrors the canonical requireBearer pattern) ----

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

// ---- HF token header extraction ----

function extractHfToken(request: import('fastify').FastifyRequest): string | undefined {
  const raw = request.headers['x-hf-token'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

// ---- ownership check (rail-keeper #17) ----
// 404 for both not-exists and not-owned to avoid information leak about
// resource existence to non-owners.

async function assertProjectOwnership(
  pool: import('pg').Pool,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const db = drizzle(pool);
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, userId)))
    .limit(1);
  return rows.length === 1;
}

// ---- plugin ----

export const datasetReferencesPlugin: FastifyPluginAsync<DatasetReferencesPluginOptions> = async (
  app,
  opts,
) => {
  // GET /huggingface/datasets/search — passthrough to HF Hub.
  // Category 2 read-only per ADR-0039 — no chain emission.
  app.get('/huggingface/datasets/search', async (request, reply) => {
    const auth = requireBearer(request, reply, opts.jwtKey);
    if (!auth) return;

    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid-request',
          message: 'invalid search query',
          details: parsed.error.flatten(),
        },
      });
    }

    try {
      const results = await searchDatasets({
        q: parsed.data.q,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        userToken: extractHfToken(request),
      });
      return reply.send({ results });
    } catch (err) {
      return handleExternalFetchError(reply, err, 'huggingface-search-failed');
    }
  });

  // GET /huggingface/datasets/:dataset_id — passthrough metadata.
  // Category 2 read-only per ADR-0039 — no chain emission.
  app.get<{ Params: { dataset_id: string } }>(
    '/huggingface/datasets/:dataset_id',
    async (request, reply) => {
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      // dataset_id can contain '/' for org-scoped datasets (e.g. "stanfordnlp/imdb")
      // — Fastify decodes path params automatically; we pass through.
      try {
        const info = await getDatasetInfo({
          datasetId: request.params.dataset_id,
          userToken: extractHfToken(request),
        });
        if (info === null) {
          return reply.code(404).send({
            error: {
              code: 'dataset-not-found',
              message: `no HF dataset with id '${request.params.dataset_id}'`,
            },
          });
        }
        return reply.send({ info });
      } catch (err) {
        return handleExternalFetchError(reply, err, 'huggingface-info-failed');
      }
    },
  );

  // POST /projects/:project_id/dataset-references — record a reference.
  //
  // Category 1 emission per ADR-0039 — user-stated provenance claim.
  // Rail-keepers: #14 (schema-validated), #15 (HF tagged at chokepoint),
  // #16 (user_token is user-scoped), #17 (ownership), #18 (idempotent
  // on same active reference).
  app.post<{ Params: { project_id: string } }>(
    '/projects/:project_id/dataset-references',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const projectId = request.params.project_id;

      const parsed = CreateReferenceBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'invalid-request',
            message: 'invalid create-dataset-reference body',
            details: parsed.error.flatten(),
          },
        });
      }

      // Rail-keeper #17 — ownership gate before any work.
      const ownedByUser = await assertProjectOwnership(app.pool, auth.userId, projectId);
      if (!ownedByUser) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'no such project' } });
      }

      // Rail-keeper #18 — idempotency. If an active reference already
      // exists for (project, registry, dataset_id), return it without
      // emitting a duplicate chain event.
      const db = drizzle(app.pool);
      const existing = await db
        .select()
        .from(projectDatasetReferences)
        .where(
          and(
            eq(projectDatasetReferences.projectId, projectId),
            eq(projectDatasetReferences.sourceRegistry, 'huggingface'),
            eq(projectDatasetReferences.datasetId, parsed.data.dataset_id),
            isNull(projectDatasetReferences.removedAt),
          ),
        )
        .limit(1);
      if (existing.length === 1) {
        const row = existing[0]!;
        return reply.code(200).send({
          idempotent: true,
          reference: rowToResponse(row),
        });
      }

      // Fetch HF info to enrich the payload (name, license, task_type).
      let info;
      try {
        info = await getDatasetInfo({
          datasetId: parsed.data.dataset_id,
          ...(parsed.data.user_token !== undefined ? { userToken: parsed.data.user_token } : {}),
        });
      } catch (err) {
        return handleExternalFetchError(reply, err, 'huggingface-info-failed');
      }
      if (info === null) {
        return reply.code(404).send({
          error: {
            code: 'dataset-not-found',
            message: `no HF dataset with id '${parsed.data.dataset_id}'`,
          },
        });
      }

      const referenceId = crypto.randomUUID();
      const summary = info; // info includes summary fields
      const datasetUrl = deriveDatasetUrl(parsed.data.dataset_id);
      const datasetName = deriveDatasetName(summary, info);
      const license = deriveLicense(info);
      const taskType = deriveTaskType(info);
      const occurredAt = new Date().toISOString();

      const payload: DatasetReferencedPayload = {
        kind: 'dataset-referenced',
        version: 1,
        project_id: projectId,
        reference_id: referenceId,
        source_registry: 'huggingface',
        dataset_id: parsed.data.dataset_id,
        dataset_url: datasetUrl,
        dataset_name: datasetName,
        ...(license !== undefined ? { license } : {}),
        ...(taskType !== undefined ? { task_type: taskType } : {}),
        occurred_at: occurredAt,
      };

      const ledger = createPostgresLedger({ pool: app.pool });
      let eventHash: string;
      try {
        eventHash = await appendDatasetReferenced({
          ledger,
          identity: opts.platformIdentity,
          userId: auth.userId,
          payload,
        });
      } catch (err) {
        await ledger.close();
        app.log.error({ err, projectId, userId: auth.userId }, 'dataset-referenced emit failed');
        return reply.code(500).send({
          error: {
            code: 'chain-append-failed',
            message: 'dataset reference aborted; row not written',
          },
        });
      }
      await ledger.close();

      // Insert row with the event hash. The chain has already extended;
      // if this insert fails the chain has a record without a row — that
      // mirrors the project-created discipline (chain leads; row catches up).
      const inserted = await db
        .insert(projectDatasetReferences)
        .values({
          id: referenceId,
          projectId,
          sourceRegistry: 'huggingface',
          datasetId: parsed.data.dataset_id,
          datasetUrl,
          datasetName,
          license: license ?? null,
          taskType: taskType ?? null,
          creationEventHash: eventHash,
        })
        .returning();
      const row = inserted[0]!;

      return reply.code(201).send({
        idempotent: false,
        reference: rowToResponse(row),
        chain_event_hash: eventHash,
      });
    },
  );

  // GET /projects/:project_id/dataset-references — list this project's references.
  // Category 2 read-only — no chain emission.
  app.get<{ Params: { project_id: string }; Querystring: { include_removed?: string } }>(
    '/projects/:project_id/dataset-references',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const projectId = request.params.project_id;
      const ownedByUser = await assertProjectOwnership(app.pool, auth.userId, projectId);
      if (!ownedByUser) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'no such project' } });
      }

      const includeRemoved =
        request.query.include_removed === 'true' || request.query.include_removed === '1';

      const db = drizzle(app.pool);
      const rows = includeRemoved
        ? await db
            .select()
            .from(projectDatasetReferences)
            .where(eq(projectDatasetReferences.projectId, projectId))
            .orderBy(desc(projectDatasetReferences.createdAt))
        : await db
            .select()
            .from(projectDatasetReferences)
            .where(
              and(
                eq(projectDatasetReferences.projectId, projectId),
                isNull(projectDatasetReferences.removedAt),
              ),
            )
            .orderBy(desc(projectDatasetReferences.createdAt));

      return reply.send({
        project_id: projectId,
        references: rows.map(rowToResponse),
      });
    },
  );

  // DELETE /projects/:project_id/dataset-references/:reference_id
  // — soft-remove a reference; emit a compensating dataset-reference-removed event.
  // Category 1 emission with D.11 undo-emits-compensating-event semantics.
  app.delete<{ Params: { project_id: string; reference_id: string } }>(
    '/projects/:project_id/dataset-references/:reference_id',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const projectId = request.params.project_id;
      const referenceId = request.params.reference_id;

      const ownedByUser = await assertProjectOwnership(app.pool, auth.userId, projectId);
      if (!ownedByUser) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'no such project' } });
      }

      const db = drizzle(app.pool);
      const found = await db
        .select()
        .from(projectDatasetReferences)
        .where(
          and(
            eq(projectDatasetReferences.id, referenceId),
            eq(projectDatasetReferences.projectId, projectId),
            isNull(projectDatasetReferences.removedAt),
          ),
        )
        .limit(1);
      if (found.length === 0) {
        return reply
          .code(404)
          .send({ error: { code: 'not-found', message: 'no active reference with that id' } });
      }
      const row = found[0]!;

      const occurredAt = new Date().toISOString();
      const payload: DatasetReferenceRemovedPayload = {
        kind: 'dataset-reference-removed',
        version: 1,
        project_id: projectId,
        reference_id: referenceId,
        original_event_hash: row.creationEventHash,
        occurred_at: occurredAt,
      };

      const ledger = createPostgresLedger({ pool: app.pool });
      let eventHash: string;
      try {
        eventHash = await appendDatasetReferenceRemoved({
          ledger,
          identity: opts.platformIdentity,
          userId: auth.userId,
          payload,
        });
      } catch (err) {
        await ledger.close();
        app.log.error(
          { err, projectId, referenceId, userId: auth.userId },
          'dataset-reference-removed emit failed',
        );
        return reply.code(500).send({
          error: {
            code: 'chain-append-failed',
            message: 'dataset reference removal aborted; row unchanged',
          },
        });
      }
      await ledger.close();

      // Update row with removed_at and removal_event_hash.
      await db
        .update(projectDatasetReferences)
        .set({
          removedAt: new Date(occurredAt),
          removalEventHash: eventHash,
        })
        .where(eq(projectDatasetReferences.id, referenceId));

      return reply.code(204).send();
    },
  );
};

// ---- helpers ----

interface ReferenceResponse {
  id: string;
  project_id: string;
  source_registry: string;
  dataset_id: string;
  dataset_url: string;
  dataset_name: string;
  license: string | null;
  task_type: string | null;
  created_at: string;
  removed_at: string | null;
  creation_event_hash: string;
  removal_event_hash: string | null;
}

function rowToResponse(row: {
  id: string;
  projectId: string;
  sourceRegistry: string;
  datasetId: string;
  datasetUrl: string;
  datasetName: string;
  license: string | null;
  taskType: string | null;
  createdAt: Date;
  removedAt: Date | null;
  creationEventHash: string;
  removalEventHash: string | null;
}): ReferenceResponse {
  return {
    id: row.id,
    project_id: row.projectId,
    source_registry: row.sourceRegistry,
    dataset_id: row.datasetId,
    dataset_url: row.datasetUrl,
    dataset_name: row.datasetName,
    license: row.license,
    task_type: row.taskType,
    created_at: row.createdAt.toISOString(),
    removed_at: row.removedAt?.toISOString() ?? null,
    creation_event_hash: row.creationEventHash,
    removal_event_hash: row.removalEventHash,
  };
}

function handleExternalFetchError(
  reply: import('fastify').FastifyReply,
  err: unknown,
  code: string,
): import('fastify').FastifyReply {
  if (err instanceof ExternalFetchError) {
    if (err.kind === 'rate-limited') {
      return reply.code(503).send({
        error: { code: 'upstream-rate-limited', message: 'HF Hub rate-limited; retry later' },
      });
    }
    if (err.kind === 'timeout' || err.kind === 'network') {
      return reply.code(503).send({
        error: { code: 'upstream-unavailable', message: 'HF Hub unreachable; retry later' },
      });
    }
    return reply.code(502).send({
      error: { code, message: err.message, upstream_status: err.status ?? null },
    });
  }
  return reply.code(500).send({
    error: { code: 'unknown-error', message: 'unexpected error reaching HF Hub' },
  });
}
