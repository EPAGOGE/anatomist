import { describe, it, expect } from 'vitest';
import { estimateJobCost, nanosToUsd, usdToNanos, NANOS_PER_USD } from '../src/index.js';

describe('estimateJobCost', () => {
  it('multiplies rate by hours in nanoUSD', () => {
    const e = estimateJobCost({ usdPerHour: 2, hours: 3 });
    expect(e.totalNanos).toBe(6n * NANOS_PER_USD);
    expect(nanosToUsd(e.totalNanos)).toBeCloseTo(6);
  });

  it('scales compute by gpuCount', () => {
    const e = estimateJobCost({ usdPerHour: 1, hours: 1, gpuCount: 4 });
    expect(e.computeNanos).toBe(4n * NANOS_PER_USD);
  });

  it('adds storage without scaling it by gpuCount', () => {
    const e = estimateJobCost({ usdPerHour: 1, hours: 2, gpuCount: 3, storageUsdPerHour: 0.5 });
    expect(e.computeNanos).toBe(6n * NANOS_PER_USD); // 1 * 2h * 3 gpus
    expect(e.storageNanos).toBe(1n * NANOS_PER_USD); // 0.5 * 2h
    expect(e.totalNanos).toBe(7n * NANOS_PER_USD);
  });

  it('handles fractional hours with half-up rounding', () => {
    const e = estimateJobCost({ usdPerHour: 2, hours: 0.5 });
    expect(e.totalNanos).toBe(1n * NANOS_PER_USD); // $1
  });

  it('is zero for non-positive rate or hours', () => {
    expect(estimateJobCost({ usdPerHour: 0, hours: 5 }).totalNanos).toBe(0n);
    expect(estimateJobCost({ usdPerHour: 5, hours: 0 }).totalNanos).toBe(0n);
  });

  it('flags reference-derived estimates', () => {
    expect(estimateJobCost({ usdPerHour: 1, hours: 1 }).reference).toBe(false);
    expect(estimateJobCost({ usdPerHour: 1, hours: 1 }, { reference: true }).reference).toBe(true);
  });
});

describe('usd <-> nanos round-trip', () => {
  it('converts exactly at whole dollars', () => {
    expect(usdToNanos(12)).toBe(12n * NANOS_PER_USD);
    expect(nanosToUsd(12n * NANOS_PER_USD)).toBe(12);
  });
});
