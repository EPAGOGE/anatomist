// RunPod adapter for the compute control plane.
//
// Fetches LIVE GPU prices at runtime via RunPod's GraphQL `gpuTypes` query
// (lowestPrice.uninterruptablePrice = on-demand USD/hour) and degrades to the
// reference catalog — marking estimates `reference: true` — when there's no API
// key or the network is unavailable. Provisioning is deliberately NOT wired from
// this untested sandbox path: it validates the spec (no tripwire → refuse) and
// then throws, pending the REST create-pod slice behind an explicit go-gate.

import { GPU_CATALOG, referencePrice } from './gpu.js';
import type { GpuId, GpuSpec } from './gpu.js';
import { estimateJobCost } from './cost.js';
import type { CostEstimate } from './cost.js';
import { validateJobSpec } from './job.js';
import type { TrainingJobSpec } from './job.js';
import type { ComputeProvider, JobStatus, ProvisionHandle } from './provider.js';

/**
 * Best-known RunPod gpuTypeIds for our curated catalog. Verify against a live
 * `gpuTypes` query — a mismatch simply falls back to the reference price, never
 * a wrong one.
 */
export const RUNPOD_GPU_TYPE_IDS: Record<GpuId, string> = {
  RTX_4090: 'NVIDIA GeForce RTX 4090',
  RTX_A6000: 'NVIDIA RTX A6000',
  L40S: 'NVIDIA L40S',
  A100_40GB: 'NVIDIA A100-PCIE-40GB',
  A100_80GB: 'NVIDIA A100 80GB PCIe',
  H100_80GB: 'NVIDIA H100 80GB HBM3',
  H200: 'NVIDIA H200',
};

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface RunPodOptions {
  apiKey?: string;
  /** Injectable for testing; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  graphqlUrl?: string;
}

const GRAPHQL_URL = 'https://api.runpod.io/graphql';

export class RunPodProvider implements ComputeProvider {
  readonly id = 'runpod';
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly graphqlUrl: string;

  constructor(opts: RunPodOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env['RUNPOD_API_KEY'];
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.graphqlUrl = opts.graphqlUrl ?? GRAPHQL_URL;
  }

  /** Curated catalog with live prices overlaid; per-GPU reference fallback on miss. */
  async listGpus(): Promise<GpuSpec[]> {
    const live = await this.fetchLivePrices();
    return (Object.keys(GPU_CATALOG) as GpuId[]).map((id) => {
      const base = GPU_CATALOG[id];
      const livePrice = live.get(RUNPOD_GPU_TYPE_IDS[id]);
      return livePrice != null ? { ...base, referenceUsdPerHour: livePrice } : base;
    });
  }

  async estimateCost(spec: TrainingJobSpec, hours: number): Promise<CostEstimate> {
    const live = await this.fetchLivePrices();
    const livePrice = live.get(RUNPOD_GPU_TYPE_IDS[spec.gpu]);
    const usdPerHour = livePrice ?? referencePrice(spec.gpu);
    return estimateJobCost(
      { usdPerHour, hours, gpuCount: spec.gpuCount ?? 1 },
      { reference: livePrice == null },
    );
  }

  async provision(spec: TrainingJobSpec): Promise<ProvisionHandle> {
    const issues = validateJobSpec(spec);
    if (issues.length > 0) {
      const detail = issues.map((i) => `${i.field}: ${i.message}`).join('; ');
      throw new Error(`invalid job spec — refusing to provision: ${detail}`);
    }
    if (!this.apiKey) throw new Error('RUNPOD_API_KEY is required to provision');
    // Real create-pod (REST Pods API) lands in the next slice, behind the
    // route-layer go-gate. This adapter never spends money from an untested path.
    throw new Error('provision() not yet wired — pending REST create-pod slice + explicit go-gate');
  }

  async status(): Promise<JobStatus> {
    throw new Error('status() not yet wired — pending REST Pods slice');
  }

  async terminate(): Promise<void> {
    throw new Error('terminate() not yet wired — pending REST Pods slice');
  }

  /**
   * GraphQL `gpuTypes` → map of gpuTypeId → on-demand USD/hour. Returns an empty
   * map on any failure (no key, non-200, network error, malformed body) so
   * callers fall back to reference prices rather than crash.
   */
  private async fetchLivePrices(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.apiKey) return out;
    try {
      const res = await this.fetchImpl(`${this.graphqlUrl}?api_key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            'query { gpuTypes { id lowestPrice(input:{gpuCount:1}) { uninterruptablePrice } } }',
        }),
      });
      if (!res.ok) return out;
      const json = (await res.json()) as {
        data?: {
          gpuTypes?: Array<{
            id?: string;
            lowestPrice?: { uninterruptablePrice?: number | null } | null;
          }>;
        };
      };
      for (const g of json.data?.gpuTypes ?? []) {
        const price = g.lowestPrice?.uninterruptablePrice;
        if (g.id && typeof price === 'number' && price > 0) out.set(g.id, price);
      }
    } catch {
      return new Map();
    }
    return out;
  }
}
