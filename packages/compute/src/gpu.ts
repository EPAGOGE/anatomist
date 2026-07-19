// GPU catalog with REFERENCE prices.
//
// These prices are a clearly-labelled fallback ONLY. The live provider adapter
// (see provider.ts) fetches real per-GPU-hour prices at runtime, where it has
// network egress. This table exists so cost estimates render offline and tests
// are deterministic — never treat it as authoritative for spend decisions.

export type GpuId =
  | 'RTX_4090'
  | 'RTX_A6000'
  | 'L40S'
  | 'A100_40GB'
  | 'A100_80GB'
  | 'H100_80GB'
  | 'H200';

export interface GpuSpec {
  id: GpuId;
  displayName: string;
  vramGb: number;
  /** REFERENCE on-demand price, USD per GPU-hour. Verify live before any spend. */
  referenceUsdPerHour: number;
}

/**
 * Reference catalog — approximate secure-cloud on-demand rates, for offline
 * estimates only. The live adapter overrides these.
 */
export const GPU_CATALOG: Record<GpuId, GpuSpec> = {
  RTX_4090: {
    id: 'RTX_4090',
    displayName: 'RTX 4090 (24 GB)',
    vramGb: 24,
    referenceUsdPerHour: 0.69,
  },
  RTX_A6000: {
    id: 'RTX_A6000',
    displayName: 'RTX A6000 (48 GB)',
    vramGb: 48,
    referenceUsdPerHour: 0.79,
  },
  L40S: { id: 'L40S', displayName: 'L40S (48 GB)', vramGb: 48, referenceUsdPerHour: 0.99 },
  A100_40GB: {
    id: 'A100_40GB',
    displayName: 'A100 (40 GB)',
    vramGb: 40,
    referenceUsdPerHour: 1.19,
  },
  A100_80GB: {
    id: 'A100_80GB',
    displayName: 'A100 (80 GB)',
    vramGb: 80,
    referenceUsdPerHour: 1.64,
  },
  H100_80GB: {
    id: 'H100_80GB',
    displayName: 'H100 (80 GB)',
    vramGb: 80,
    referenceUsdPerHour: 2.79,
  },
  H200: { id: 'H200', displayName: 'H200 (141 GB)', vramGb: 141, referenceUsdPerHour: 3.99 },
};

/** Reference price for a GPU, USD/hour. */
export function referencePrice(gpu: GpuId): number {
  return GPU_CATALOG[gpu].referenceUsdPerHour;
}

/** GPUs with at least `vramGb` of VRAM, cheapest reference price first. */
export function gpusWithAtLeastVram(vramGb: number): GpuSpec[] {
  return Object.values(GPU_CATALOG)
    .filter((g) => g.vramGb >= vramGb)
    .sort((a, b) => a.referenceUsdPerHour - b.referenceUsdPerHour);
}
