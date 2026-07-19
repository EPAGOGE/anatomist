// Code export HTTP routes — F-0 Task 106 (basic GitHub code export, PAT-first).
//
//   POST /projects/:project_id/code-exports
//   GET  /projects/:project_id/code-exports
//
// Scope governor (build doc + slow-roll): "basic" — one-directional
// code export, explicit per-export user action, no platform-side
// credential storage. The user provides a Personal Access Token (PAT)
// in each request body; the platform uses it and discards it. OAuth
// is deferred (see ADR-0041 for the PAT-first rationale).
//
// Active rail-keepers honored here:
//   #11 External-API chokepoint  — all GitHub calls via apps/api/src/external/github.ts
//   #14 Schema-first design       — CodeExportedPayloadSchema in @epagoge/shared
//   #15 Emission classification   — read-only + state-change-on-target tagged at github.ts call sites
//   #16 User-scoped credentials   — PAT is per-request, never platform-wide
//   #17 Project-ownership assert  — every mutation gated on ownership; 404 same response for not-exists/not-owned
//   #19 Named-exception negative tests — covered in routes.test.ts (ownership rejections do NOT emit)
//
// Re-export is NOT idempotent (deliberate departure from Task 105):
// every code-export creates a new row + new chain event.

import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import { createPostgresLedger } from '@epagoge/ledger';
import type { CodeExportedPayload } from '@epagoge/shared';
import { blake3 } from '@epagoge/crypto';
import { ComponentRegistry, loadMlDomain } from '@epagoge/components';
import { generatePytorch, type GraphSpec } from '@epagoge/codegen';
import { verifyToken, type JwtKey } from '../auth/jwt.js';
import type { LocalIdentity } from '../identity/local-key-store.js';
import { projects, projectCodeExports } from '../db/schema.js';
import { appendCodeExported } from '../projects/project-events.js';
import { getUserArchitectureEvent } from '../canvas/architecture-events.js';
import { getRepo, getContentsFileSha, putContents } from '../external/github.js';
import { ExternalFetchError } from '../external/http.js';

export interface CodeExportsPluginOptions {
  jwtKey: JwtKey;
  platformIdentity: LocalIdentity;
}

const CreateExportBodySchema = z.object({
  architecture_event_hash: z.string().regex(/^[0-9a-f]{64}$/),
  destination_kind: z.literal('github'),
  destination_repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'must be in owner/repo format')
    .max(255),
  destination_branch: z.string().min(1).max(255).default('main'),
  destination_path: z.string().min(1).max(512),
  commit_message: z.string().max(1024).optional(),
  /** PAT — per rail-keeper #16, never persisted. */
  user_token: z.string().min(40).max(512),
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

let _registry: ComponentRegistry | null = null;
function getCodeExportRegistry(): ComponentRegistry {
  if (_registry) return _registry;
  const r = new ComponentRegistry();
  loadMlDomain(r);
  _registry = r;
  return r;
}

export const codeExportsPlugin: FastifyPluginAsync<CodeExportsPluginOptions> = async (
  app,
  opts,
) => {
  app.post<{ Params: { project_id: string } }>(
    '/projects/:project_id/code-exports',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = requireBearer(request, reply, opts.jwtKey);
      if (!auth) return;

      const projectId = request.params.project_id;

      const parsed = CreateExportBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'invalid-request',
            message: 'invalid create-code-export body',
            details: parsed.error.flatten(),
          },
        });
      }

      const ownedByUser = await assertProjectOwnership(app.pool, auth.userId, projectId);
      if (!ownedByUser) {
        return reply.code(404).send({ error: { code: 'not-found', message: 'no such project' } });
      }

      const ledger = createPostgresLedger({ pool: app.pool });
      const archResult = await getUserArchitectureEvent({
        ledger,
        userId: auth.userId,
        eventHash: parsed.data.architecture_event_hash,
      });
      if (!archResult) {
        await ledger.close();
        return reply.code(404).send({
          error: {
            code: 'architecture-not-found',
            message: 'no such architecture event in your chain',
          },
        });
      }
      const archPayload = archResult.payload;

      if (archPayload.project_id !== undefined && archPayload.project_id !== projectId) {
        await ledger.close();
        return reply.code(404).send({
          error: {
            code: 'architecture-not-found',
            message: 'architecture does not belong to this project',
          },
        });
      }

      const registry = getCodeExportRegistry();
      const graph: GraphSpec = {
        version: 1,
        name: archPayload.name,
        ...(archPayload.description !== undefined ? { description: archPayload.description } : {}),
        nodes: archPayload.nodes,
        edges: archPayload.edges,
      };
      let generatedCode: string;
      try {
        generatedCode = generatePytorch(graph, registry);
      } catch (err) {
        await ledger.close();
        app.log.error({ err, projectId, userId: auth.userId }, 'codegen failed during export');
        return reply.code(500).send({
          error: {
            code: 'codegen-failed',
            message: 'could not generate PyTorch code from the architecture',
          },
        });
      }

      const codeHash = Buffer.from(blake3.hash(Buffer.from(generatedCode, 'utf8'))).toString('hex');

      const [owner, repo] = parsed.data.destination_repo.split('/');
      if (!owner || !repo) {
        await ledger.close();
        return reply.code(400).send({
          error: { code: 'invalid-request', message: 'destination_repo must be owner/repo' },
        });
      }

      // Pre-flight: confirm repo + PAT push permission.
      try {
        const repoInfo = await getRepo({ owner, repo, userToken: parsed.data.user_token });
        if (repoInfo === null) {
          await ledger.close();
          return reply.code(404).send({
            error: {
              code: 'repo-not-found',
              message: `no GitHub repo at ${parsed.data.destination_repo} (or PAT lacks visibility)`,
            },
          });
        }
        if (repoInfo.permissions?.push === false) {
          await ledger.close();
          return reply.code(403).send({
            error: {
              code: 'insufficient-pat-scope',
              message: 'PAT does not have push permission on the destination repo',
            },
          });
        }
      } catch (err) {
        await ledger.close();
        return handleExternalFetchError(reply, err, 'github-repo-check-failed');
      }

      let existingFileSha: string | null;
      try {
        existingFileSha = await getContentsFileSha({
          owner,
          repo,
          path: parsed.data.destination_path,
          branch: parsed.data.destination_branch,
          userToken: parsed.data.user_token,
        });
      } catch (err) {
        await ledger.close();
        return handleExternalFetchError(reply, err, 'github-contents-check-failed');
      }

      const commitMessage =
        parsed.data.commit_message ??
        `Export attested architecture ${archPayload.architecture_id} via EPAGOGE platform`;

      let putResult;
      try {
        putResult = await putContents({
          owner,
          repo,
          path: parsed.data.destination_path,
          content: generatedCode,
          message: commitMessage,
          branch: parsed.data.destination_branch,
          ...(existingFileSha !== null ? { sha: existingFileSha } : {}),
          userToken: parsed.data.user_token,
        });
      } catch (err) {
        await ledger.close();
        return handleExternalFetchError(reply, err, 'github-push-failed');
      }

      const commitSha = putResult.commit.sha;
      const exportId = randomUUID();
      const occurredAt = new Date().toISOString();

      const payload: CodeExportedPayload = {
        kind: 'code-exported',
        version: 1,
        project_id: projectId,
        export_id: exportId,
        architecture_id: archPayload.architecture_id,
        architecture_event_hash: parsed.data.architecture_event_hash,
        destination_kind: 'github',
        destination_repo: parsed.data.destination_repo,
        destination_branch: parsed.data.destination_branch,
        destination_path: parsed.data.destination_path,
        commit_sha: commitSha,
        code_hash: codeHash,
        occurred_at: occurredAt,
      };

      let chainEventHash: string;
      try {
        chainEventHash = await appendCodeExported({
          ledger,
          identity: opts.platformIdentity,
          userId: auth.userId,
          payload,
        });
      } catch (err) {
        await ledger.close();
        app.log.error(
          { err, projectId, exportId, commitSha },
          'code-exported emission failed after successful GitHub push',
        );
        return reply.code(500).send({
          error: {
            code: 'chain-emit-after-push-failed',
            message:
              'GitHub push succeeded but chain record failed; manual reconciliation required',
            details: {
              commit_sha: commitSha,
              destination: parsed.data.destination_repo,
              architecture_id: archPayload.architecture_id,
            },
          },
        });
      }
      await ledger.close();

      const db = drizzle(app.pool);
      const inserted = await db
        .insert(projectCodeExports)
        .values({
          id: exportId,
          projectId,
          architectureId: archPayload.architecture_id,
          architectureEventHash: parsed.data.architecture_event_hash,
          destinationKind: 'github',
          destinationRepo: parsed.data.destination_repo,
          destinationBranch: parsed.data.destination_branch,
          destinationPath: parsed.data.destination_path,
          commitSha,
          codeHash,
          chainEventHash,
        })
        .returning();
      const row = inserted[0]!;

      return reply.code(201).send({
        export: rowToResponse(row),
        chain_event_hash: chainEventHash,
        commit_html_url: putResult.commit.html_url,
      });
    },
  );

  app.get<{ Params: { project_id: string } }>(
    '/projects/:project_id/code-exports',
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

      const db = drizzle(app.pool);
      const rows = await db
        .select()
        .from(projectCodeExports)
        .where(eq(projectCodeExports.projectId, projectId))
        .orderBy(desc(projectCodeExports.createdAt));

      return reply.send({
        project_id: projectId,
        exports: rows.map(rowToResponse),
      });
    },
  );
};

interface ExportResponse {
  id: string;
  project_id: string;
  architecture_id: string;
  architecture_event_hash: string;
  destination_kind: string;
  destination_repo: string;
  destination_branch: string;
  destination_path: string;
  commit_sha: string;
  code_hash: string;
  created_at: string;
  chain_event_hash: string;
}

function rowToResponse(row: {
  id: string;
  projectId: string;
  architectureId: string;
  architectureEventHash: string;
  destinationKind: string;
  destinationRepo: string;
  destinationBranch: string;
  destinationPath: string;
  commitSha: string;
  codeHash: string;
  createdAt: Date;
  chainEventHash: string;
}): ExportResponse {
  return {
    id: row.id,
    project_id: row.projectId,
    architecture_id: row.architectureId,
    architecture_event_hash: row.architectureEventHash,
    destination_kind: row.destinationKind,
    destination_repo: row.destinationRepo,
    destination_branch: row.destinationBranch,
    destination_path: row.destinationPath,
    commit_sha: row.commitSha,
    code_hash: row.codeHash,
    created_at: row.createdAt.toISOString(),
    chain_event_hash: row.chainEventHash,
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
        error: { code: 'upstream-rate-limited', message: 'GitHub rate-limited; retry later' },
      });
    }
    if (err.kind === 'timeout' || err.kind === 'network') {
      return reply.code(503).send({
        error: { code: 'upstream-unavailable', message: 'GitHub unreachable; retry later' },
      });
    }
    if (err.kind === 'http-4xx' && err.status === 401) {
      return reply
        .code(401)
        .send({ error: { code: 'github-auth-failed', message: 'PAT rejected by GitHub (401)' } });
    }
    if (err.kind === 'http-4xx' && err.status === 403) {
      return reply.code(403).send({
        error: { code: 'github-forbidden', message: 'PAT lacks required scope (403)' },
      });
    }
    if (err.kind === 'http-4xx' && err.status === 404) {
      return reply
        .code(404)
        .send({ error: { code: 'repo-not-found', message: 'GitHub returned 404' } });
    }
    if (err.kind === 'http-4xx' && err.status === 422) {
      return reply.code(422).send({
        error: {
          code: 'github-validation-failed',
          message: 'GitHub rejected the request (422 — likely sha mismatch or branch error)',
        },
      });
    }
    return reply.code(502).send({
      error: { code, message: err.message, upstream_status: err.status ?? null },
    });
  }
  return reply.code(500).send({
    error: { code: 'unknown-error', message: 'unexpected error during GitHub operation' },
  });
}
