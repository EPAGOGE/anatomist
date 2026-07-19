import { describe, it, expect } from 'vitest';
import { checkTripwire, tripwireFromBudget, NANOS_PER_USD } from '../src/index.js';

const limits = tripwireFromBudget({ maxUsd: 10, maxMinutes: 60, maxIdleMinutes: 5 });

function reasonOf(v: ReturnType<typeof checkTripwire>): string {
  return v.action === 'terminate' ? v.reason : '';
}

describe('checkTripwire', () => {
  it('continues when under every limit', () => {
    const v = checkTripwire(limits, { accruedNanos: 5n * NANOS_PER_USD, elapsedSeconds: 100 });
    expect(v.action).toBe('continue');
  });

  it('terminates at the cost cap', () => {
    const v = checkTripwire(limits, { accruedNanos: 10n * NANOS_PER_USD, elapsedSeconds: 100 });
    expect(v.action).toBe('terminate');
    expect(reasonOf(v)).toContain('cost cap');
  });

  it('terminates at max runtime', () => {
    const v = checkTripwire(limits, { accruedNanos: 1n * NANOS_PER_USD, elapsedSeconds: 3600 });
    expect(v.action).toBe('terminate');
    expect(reasonOf(v)).toContain('max runtime');
  });

  it('terminates on the idle guard', () => {
    const v = checkTripwire(limits, {
      accruedNanos: 1n,
      elapsedSeconds: 10,
      secondsSinceProgress: 300,
    });
    expect(v.action).toBe('terminate');
    expect(reasonOf(v)).toContain('idle');
  });

  it('prioritises the cost cap over other breaches', () => {
    const v = checkTripwire(limits, { accruedNanos: 10n * NANOS_PER_USD, elapsedSeconds: 999999 });
    expect(reasonOf(v)).toContain('cost cap');
  });

  it('ignores the idle guard when maxIdleMinutes is unset', () => {
    const noIdle = tripwireFromBudget({ maxUsd: 10, maxMinutes: 60 });
    const v = checkTripwire(noIdle, {
      accruedNanos: 1n,
      elapsedSeconds: 10,
      secondsSinceProgress: 10_000,
    });
    expect(v.action).toBe('continue');
  });
});

describe('tripwireFromBudget', () => {
  it('converts USD to nanos and minutes to seconds', () => {
    const l = tripwireFromBudget({ maxUsd: 2.5, maxMinutes: 30 });
    expect(l.maxCostNanos).toBe(2_500_000_000n);
    expect(l.maxRuntimeSeconds).toBe(1800);
    expect(l.maxIdleSeconds).toBeUndefined();
  });
});
