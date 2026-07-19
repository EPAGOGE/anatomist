// Per-user monthly AI budget enforcement.
//
// One row per (user_id, period_start) in ai_budgets. period_start is the
// first day of a calendar month in UTC. The orchestrator calls
// preFlightCheck(user_id, estimated_nanos) before every API call — it
// returns ALLOW, WARN, or BLOCK based on the user's current spend vs
// their cap. Subsequent debit() applies the actual cost after the call.
//
// Both ai_interactions.cost_total_nanos AND ai_budgets.spent_nanos
// track spend; they are kept in sync by debit(). The ai_interactions
// table is the authoritative analytics surface; ai_budgets is the
// fast read-model used at request time.

import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { aiBudgets } from '../db/schema.js';

/**
 * Pre-flight budget verdict.
 *
 * `spentNanos` is the CURRENT period spend at the moment of the check
 * (i.e., the value in the database row before this call's actual cost
 * is debited). `remainingNanos` is `capNanos - spentNanos`. Callers
 * that want to display post-call state compute it themselves from
 * `spentNanos + actualCostNanos`.
 *
 * Earlier this type returned the AFTER-estimate projected values,
 * which surfaced a confusing $0.50 "spent" on freshly-registered
 * users because the default per-call estimate was $0.50 (see
 * DEFAULT_MAX_NANOS_PER_CALL). Fixed in tranche after the first
 * real Anthropic roundtrip.
 */
export type BudgetVerdict =
  | { kind: 'allow'; remainingNanos: bigint; capNanos: bigint; spentNanos: bigint }
  | {
      kind: 'warn';
      remainingNanos: bigint;
      capNanos: bigint;
      spentNanos: bigint;
      warnAtPct: number;
    }
  | { kind: 'block'; spentNanos: bigint; capNanos: bigint };

/** Default monthly cap when a user has no row yet. */
export const DEFAULT_MONTHLY_CAP_NANOS = 10_000_000_000n; // $10.00 / month
export const DEFAULT_WARN_AT_PCT = 80;

/** First day of the current month in UTC, midnight. */
export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Read the user's budget row (and create one with defaults if absent).
 * The returned spentNanos is authoritative for the current period.
 */
export async function ensureBudgetRow(
  pool: pg.Pool,
  userId: string,
  now: Date = new Date(),
): Promise<{ capNanos: bigint; spentNanos: bigint; warnAtPct: number; periodStart: Date }> {
  const db = drizzle(pool);
  const period = currentPeriodStart(now);
  const existing = (
    await db
      .select()
      .from(aiBudgets)
      .where(and(eq(aiBudgets.userId, userId), eq(aiBudgets.periodStart, period)))
      .limit(1)
  )[0];
  if (existing) {
    return {
      capNanos: existing.monthlyCapNanos,
      spentNanos: existing.spentNanos,
      warnAtPct: existing.warnAtPct,
      periodStart: existing.periodStart,
    };
  }
  await db
    .insert(aiBudgets)
    .values({
      userId,
      periodStart: period,
      monthlyCapNanos: DEFAULT_MONTHLY_CAP_NANOS,
      warnAtPct: DEFAULT_WARN_AT_PCT,
      spentNanos: 0n,
    })
    .onConflictDoNothing();
  return {
    capNanos: DEFAULT_MONTHLY_CAP_NANOS,
    spentNanos: 0n,
    warnAtPct: DEFAULT_WARN_AT_PCT,
    periodStart: period,
  };
}

/**
 * Pre-flight check: would adding `estimatedNanos` to the user's current
 * spend exceed their cap? Returns ALLOW / WARN / BLOCK.
 *
 * The warn threshold fires when the AFTER-estimate spend crosses the
 * warn_at_pct boundary AND the before-estimate spend was under it. This
 * makes WARN a single-shot signal per period rather than a sticky state.
 */
export async function preFlightCheck(
  pool: pg.Pool,
  userId: string,
  estimatedNanos: bigint,
): Promise<BudgetVerdict> {
  const { capNanos, spentNanos, warnAtPct } = await ensureBudgetRow(pool, userId);
  // `projected` is the worst-case spend if this call lands at its
  // estimated upper bound. It drives the block/warn decision but is
  // never exposed to callers — the verdict reports CURRENT spent.
  const projected = spentNanos + estimatedNanos;
  if (projected > capNanos) {
    return { kind: 'block', spentNanos, capNanos };
  }
  const warnLine = (capNanos * BigInt(warnAtPct)) / 100n;
  const crossedWarn = spentNanos < warnLine && projected >= warnLine;
  const remainingNanos = capNanos - spentNanos;
  if (crossedWarn) {
    return { kind: 'warn', remainingNanos, capNanos, spentNanos, warnAtPct };
  }
  return { kind: 'allow', remainingNanos, capNanos, spentNanos };
}

/**
 * Apply an actual debit after a successful API call. UPDATE with
 * SET spent_nanos = spent_nanos + $1 so concurrent calls don't race.
 */
export async function debit(pool: pg.Pool, userId: string, costNanos: bigint): Promise<void> {
  if (costNanos === 0n) return;
  const db = drizzle(pool);
  const period = currentPeriodStart();
  await db
    .update(aiBudgets)
    .set({
      spentNanos: sql`${aiBudgets.spentNanos} + ${costNanos.toString()}::bigint`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(aiBudgets.userId, userId), eq(aiBudgets.periodStart, period)));
}
