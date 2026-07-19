// Cost / runtime tripwire — the $28 pod-idle-burn lesson made first-class.
//
// Every training job carries a HARD cost cap and a max runtime; the tripwire is
// checked on a heartbeat and returns a TERMINATE verdict (with a reason) the
// instant either is breached. This is deterministic, provider-agnostic guard
// logic — no job runs without one (validateJobSpec enforces it).

import { NANOS_PER_USD, usdToNanos } from './cost.js';

export interface TripwireLimits {
  /** Hard cost ceiling in nanoUSD. Job is killed at or above this. */
  maxCostNanos: bigint;
  /** Hard wall-clock ceiling in seconds. */
  maxRuntimeSeconds: number;
  /** Kill if no progress heartbeat for this many seconds. undefined/0 disables. */
  maxIdleSeconds?: number;
}

export interface TripwireState {
  /** Cost accrued so far, nanoUSD. */
  accruedNanos: bigint;
  /** Wall-clock since launch, seconds. */
  elapsedSeconds: number;
  /** Seconds since the last progress heartbeat (for the idle guard). */
  secondsSinceProgress?: number;
}

export type TripwireVerdict = { action: 'continue' } | { action: 'terminate'; reason: string };

/** The one function the heartbeat calls. Cost cap is checked first (highest priority). */
export function checkTripwire(limits: TripwireLimits, state: TripwireState): TripwireVerdict {
  if (state.accruedNanos >= limits.maxCostNanos) {
    return {
      action: 'terminate',
      reason: `cost cap reached: ${fmtUsd(state.accruedNanos)} >= ${fmtUsd(limits.maxCostNanos)}`,
    };
  }
  if (state.elapsedSeconds >= limits.maxRuntimeSeconds) {
    return {
      action: 'terminate',
      reason: `max runtime reached: ${state.elapsedSeconds}s >= ${limits.maxRuntimeSeconds}s`,
    };
  }
  const idleCap = limits.maxIdleSeconds ?? 0;
  const idle = state.secondsSinceProgress ?? 0;
  if (idleCap > 0 && idle >= idleCap) {
    return {
      action: 'terminate',
      reason: `idle guard tripped: ${idle}s without progress >= ${idleCap}s`,
    };
  }
  return { action: 'continue' };
}

/** Build limits from human-friendly USD + minutes. */
export function tripwireFromBudget(input: {
  maxUsd: number;
  maxMinutes: number;
  maxIdleMinutes?: number;
}): TripwireLimits {
  const limits: TripwireLimits = {
    maxCostNanos: usdToNanos(input.maxUsd),
    maxRuntimeSeconds: Math.round(input.maxMinutes * 60),
  };
  if (input.maxIdleMinutes != null) {
    limits.maxIdleSeconds = Math.round(input.maxIdleMinutes * 60);
  }
  return limits;
}

function fmtUsd(nanos: bigint): string {
  return `$${(Number(nanos) / Number(NANOS_PER_USD)).toFixed(4)}`;
}
