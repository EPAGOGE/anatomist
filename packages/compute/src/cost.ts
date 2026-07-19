// Compute cost estimation — integer nano-USD, mirroring @epagoge/ai's cost model.
//
// nano-USD: 1 USD = 1_000_000_000 nanoUSD. All money is bigint; budget/tripwire
// comparisons are exact integer arithmetic with no float drift. Display helpers
// convert to Number only at the edge.

export const NANOS_PER_USD = 1_000_000_000n;

export interface JobCostInput {
  /** GPU price, USD per GPU-hour (live from the adapter, or reference). */
  usdPerHour: number;
  /** Estimated wall-clock runtime in hours (may be fractional). */
  hours: number;
  /** Parallel GPUs (default 1). */
  gpuCount?: number;
  /** Optional attached-storage rate, USD per hour (default 0). */
  storageUsdPerHour?: number;
}

export interface CostEstimate {
  computeNanos: bigint;
  storageNanos: bigint;
  totalNanos: bigint;
  /** True when derived from the reference catalog rather than a live price. */
  reference: boolean;
}

/**
 * nanoUSD for a `usdPerHour` rate run for `hours` (fractional ok), half-up.
 *
 *   nanos = usdPerHour * 1e9 (nanos/hour)  *  hours (as micro-hours) / 1e6
 */
function rateNanos(usdPerHour: number, hours: number): bigint {
  if (usdPerHour <= 0 || hours <= 0) return 0n;
  const nanosPerHour = BigInt(Math.round(usdPerHour * 1_000_000_000));
  const microHours = BigInt(Math.round(hours * 1_000_000));
  return (nanosPerHour * microHours + 500_000n) / 1_000_000n;
}

/** Priced estimate for a run. Compute scales by gpuCount; storage does not. */
export function estimateJobCost(input: JobCostInput, opts?: { reference?: boolean }): CostEstimate {
  const gpuCount = BigInt(Math.max(1, input.gpuCount ?? 1));
  const computeNanos = rateNanos(input.usdPerHour, input.hours) * gpuCount;
  const storageNanos = rateNanos(input.storageUsdPerHour ?? 0, input.hours);
  return {
    computeNanos,
    storageNanos,
    totalNanos: computeNanos + storageNanos,
    reference: opts?.reference ?? false,
  };
}

export function nanosToUsd(nanos: bigint): number {
  return Number(nanos) / Number(NANOS_PER_USD);
}

export function usdToNanos(usd: number): bigint {
  return BigInt(Math.round(usd * Number(NANOS_PER_USD)));
}

/** Format nanos as a USD string. e.g. 6_000_000_000n -> "$6.0000". */
export function formatNanosUsd(nanos: bigint, precision = 4): string {
  return `$${nanosToUsd(nanos).toFixed(precision)}`;
}
