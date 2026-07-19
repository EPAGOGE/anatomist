// Compute control-plane HTTP surface (platform gap #1).
//
// Read-only pricing today: list GPUs and estimate a run's cost — live from the
// provider (RunPod) with reference fallback. Job creation + provisioning land
// behind a DB-backed jobs table and an explicit go-gate in later slices; this
// surface never spends money.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, type JwtKey } from '../auth/jwt.js';
import { RunPodProvider, GPU_CATALOG, formatNanosUsd } from '@epagoge/compute';
import type { GpuId, TrainingJobSpec } from '@epagoge/compute';

export interface ComputePluginOptions {
  jwtKey: JwtKey;
}

const GPU_IDS = Object.keys(GPU_CATALOG) as GpuId[];

function requireUser(request: FastifyRequest, reply: FastifyReply, jwtKey: JwtKey): boolean {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    // Local-first: no token means the local owner (see auth/local-user.ts).
    if (request.server.localIdentity) return true;
    reply.code(401).send({ error: { code: 'auth-required', message: 'bearer token required' } });
    return false;
  }
  const v = verifyToken(header.slice('Bearer '.length), jwtKey, { expectType: 'access' });
  if (!v.ok) {
    reply.code(401).send({ error: { code: 'invalid-token', message: 'token rejected' } });
    return false;
  }
  return true;
}

/** Minimal spec for a price-only estimate — the estimator reads gpu + count. */
function estimateSpec(gpu: GpuId, gpuCount: number): TrainingJobSpec {
  return {
    name: 'estimate',
    baseModel: '',
    dataset: { uri: '' },
    gpu,
    gpuCount,
    hyperparams: {},
    limits: { maxCostNanos: 1n, maxRuntimeSeconds: 1 },
    provider: 'runpod',
  };
}

export const computePlugin: FastifyPluginAsync<ComputePluginOptions> = async (app, opts) => {
  // Reads RUNPOD_API_KEY from env for live prices; reference fallback otherwise.
  const provider = new RunPodProvider();

  // GET /compute/gpus — curated catalog with live (or reference) prices.
  app.get('/compute/gpus', async (request, reply) => {
    if (!requireUser(request, reply, opts.jwtKey)) return;
    const gpus = await provider.listGpus();
    return reply.send({
      provider: provider.id,
      gpus: gpus.map((g) => ({
        id: g.id,
        display_name: g.displayName,
        vram_gb: g.vramGb,
        usd_per_hour: g.referenceUsdPerHour,
      })),
    });
  });

  // POST /compute/estimate — priced estimate for a run.
  //   body: { gpu: GpuId, gpu_count?: number, hours?: number }
  app.post<{ Body: { gpu?: string; gpu_count?: number; hours?: number } }>(
    '/compute/estimate',
    async (request, reply) => {
      if (!requireUser(request, reply, opts.jwtKey)) return;
      const body = request.body ?? {};
      const rawGpu = body.gpu;
      if (!rawGpu || !(rawGpu in GPU_CATALOG)) {
        return reply.code(400).send({
          error: { code: 'invalid-gpu', message: `gpu must be one of: ${GPU_IDS.join(', ')}` },
        });
      }
      const gpu = rawGpu as GpuId;
      const hours = typeof body.hours === 'number' && body.hours > 0 ? body.hours : 1;
      const gpuCount =
        typeof body.gpu_count === 'number' && body.gpu_count >= 1 ? Math.floor(body.gpu_count) : 1;

      const est = await provider.estimateCost(estimateSpec(gpu, gpuCount), hours);
      return reply.send({
        provider: provider.id,
        gpu,
        gpu_count: gpuCount,
        hours,
        reference_price: est.reference,
        compute_nanos: est.computeNanos.toString(),
        storage_nanos: est.storageNanos.toString(),
        total_nanos: est.totalNanos.toString(),
        total_usd_display: formatNanosUsd(est.totalNanos),
      });
    },
  );
};
