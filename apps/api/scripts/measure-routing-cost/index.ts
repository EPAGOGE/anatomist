// F-0 Criterion 6 — routing cost measurement vs Opus-only baseline.
//
// Runs each workload query TWICE through invokeAi:
//   1. With router decisions (the production routing path)
//   2. With forceTier: 'opus' (the naive baseline)
//
// Records actual cost per call from result.costNanos. Aggregates,
// computes the delta and percentage savings, writes a JSON evidence
// artifact + appends to a history JSONL.
//
// Per ADR-0038 the workload spans the routing tiers — the
// measurement is honest, not cherry-picked. Cases where routing
// chooses Opus anyway are included in the spread; those queries'
// "savings" are zero by construction, which is the truthful number.
//
// Cache busting: each call carries a per-run salt in its system prompt
// so the aiResponseCache does NOT collapse identical messages into a
// single cached response. Without this, the second call (forced Opus)
// would hit the routed result's cache and report $0 cost.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';
import { invokeAi, BudgetExceededError } from '../../src/ai/orchestrator.js';
import { WORKLOAD, type WorkloadQuery } from './workload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, '..', '..', 'verification-results');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';

interface PerQueryResult {
  readonly id: string;
  readonly category: WorkloadQuery['category'];
  readonly purpose: WorkloadQuery['purpose'];
  readonly routed: {
    readonly tier: 'haiku' | 'sonnet' | 'opus';
    readonly model: string;
    readonly cost_nanos: string;
    readonly tokens: { input: number; output: number; cache_read: number; cache_write: number };
    readonly elapsed_ms: number;
  };
  readonly opus: {
    readonly model: string;
    readonly cost_nanos: string;
    readonly tokens: { input: number; output: number; cache_read: number; cache_write: number };
    readonly elapsed_ms: number;
  };
  readonly savings_nanos: string;
  readonly savings_pct: number;
}

async function runOne(
  pool: pg.Pool,
  identity: Awaited<ReturnType<typeof ensureLocalIdentity>>['identity'],
  runSalt: string,
  query: WorkloadQuery,
): Promise<PerQueryResult> {
  // System prompt carries the per-run salt so the cache key differs
  // for every measurement run. Without this, repeated calls hit
  // cached responses and report $0.
  const systemBase = query.system ?? 'You are a helpful assistant for ML practitioners.';
  const systemWithSalt = `${systemBase}\n\n<!-- measurement-salt: ${runSalt} -->`;

  // ----- Routed call -----
  const t0 = performance.now();
  const routedResult = await invokeAi({
    pool,
    platformIdentity: identity,
    sourceId: identity.sourceId,
    purpose: query.purpose,
    feature: 'routing-cost-measurement',
    system: systemWithSalt,
    messages: [{ role: 'user', content: query.userMessage }],
    routing: {
      purpose: query.purpose,
      inputChars: query.userMessage.length + systemWithSalt.length,
      ...(query.hints.isSimple !== undefined ? { isSimple: query.hints.isSimple } : {}),
      ...(query.hints.needsReasoning !== undefined
        ? { needsReasoning: query.hints.needsReasoning }
        : {}),
    },
    maxNanosPerCall: 500_000_000n, // $0.50 hard cap per call
  });
  const routedElapsed = Math.round(performance.now() - t0);

  // ----- Opus baseline call -----
  // Different salt so the routed-tier call's cache doesn't serve this one.
  const opusSystem = `${systemBase}\n\n<!-- measurement-salt: ${runSalt}-opus -->`;
  const t1 = performance.now();
  const opusResult = await invokeAi({
    pool,
    platformIdentity: identity,
    sourceId: identity.sourceId,
    purpose: query.purpose,
    feature: 'routing-cost-measurement-opus-baseline',
    system: opusSystem,
    messages: [{ role: 'user', content: query.userMessage }],
    routing: {
      purpose: query.purpose,
      inputChars: query.userMessage.length + opusSystem.length,
      forceTier: 'opus',
    },
    maxNanosPerCall: 500_000_000n,
  });
  const opusElapsed = Math.round(performance.now() - t1);

  const routedCost = routedResult.costNanos;
  const opusCost = opusResult.costNanos;
  const savings = opusCost - routedCost;
  const savingsPct = opusCost === 0n ? 0 : Number((savings * 10000n) / opusCost) / 100;

  return {
    id: query.id,
    category: query.category,
    purpose: query.purpose,
    routed: {
      tier: routedResult.tier,
      model: routedResult.model,
      cost_nanos: routedCost.toString(),
      tokens: {
        input: routedResult.tokens.input,
        output: routedResult.tokens.output,
        cache_read: routedResult.tokens.cacheRead,
        cache_write: routedResult.tokens.cacheWrite,
      },
      elapsed_ms: routedElapsed,
    },
    opus: {
      model: opusResult.model,
      cost_nanos: opusCost.toString(),
      tokens: {
        input: opusResult.tokens.input,
        output: opusResult.tokens.output,
        cache_read: opusResult.tokens.cacheRead,
        cache_write: opusResult.tokens.cacheWrite,
      },
      elapsed_ms: opusElapsed,
    },
    savings_nanos: savings.toString(),
    savings_pct: savingsPct,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[measure] ANTHROPIC_API_KEY not set; refusing to run');
    process.exitCode = 1;
    return;
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const { identity } = await ensureLocalIdentity('local_user');
  const runSalt = `${Date.now()}-${randomUUID().slice(0, 8)}`;

  console.log(`[measure] workload size: ${WORKLOAD.length}`);
  console.log(`[measure] each query runs twice (routed + opus-baseline)`);
  console.log(`[measure] run salt: ${runSalt}`);
  console.log('');

  const results: PerQueryResult[] = [];
  for (const query of WORKLOAD) {
    process.stdout.write(`[measure] ${query.id} (${query.category}) … `);
    try {
      const r = await runOne(pool, identity, runSalt, query);
      results.push(r);
      const routedUsd = (Number(BigInt(r.routed.cost_nanos)) / 1e9).toFixed(6);
      const opusUsd = (Number(BigInt(r.opus.cost_nanos)) / 1e9).toFixed(6);
      const savedPct = r.savings_pct.toFixed(1);
      console.log(`routed=${r.routed.tier} $${routedUsd} | opus $${opusUsd} | saved ${savedPct}%`);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.error(`[measure] BUDGET EXCEEDED — aborting`);
        break;
      }
      console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------- Aggregate ----------
  let routedTotal = 0n;
  let opusTotal = 0n;
  const tierCounts: Record<string, number> = { haiku: 0, sonnet: 0, opus: 0 };
  for (const r of results) {
    routedTotal += BigInt(r.routed.cost_nanos);
    opusTotal += BigInt(r.opus.cost_nanos);
    tierCounts[r.routed.tier] = (tierCounts[r.routed.tier] ?? 0) + 1;
  }
  const savingsTotal = opusTotal - routedTotal;
  const savingsPct = opusTotal === 0n ? 0 : Number((savingsTotal * 10000n) / opusTotal) / 100;

  const summary = {
    run_at: new Date().toISOString(),
    run_salt: runSalt,
    workload_size: WORKLOAD.length,
    results_collected: results.length,
    tier_distribution: tierCounts,
    routed_total_nanos: routedTotal.toString(),
    opus_total_nanos: opusTotal.toString(),
    savings_total_nanos: savingsTotal.toString(),
    savings_pct: savingsPct,
    routed_total_usd: Number(routedTotal) / 1e9,
    opus_total_usd: Number(opusTotal) / 1e9,
    savings_total_usd: Number(savingsTotal) / 1e9,
    per_query: results,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, 'measure-routing-cost.latest.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  const histPath = join(RESULTS_DIR, 'measure-routing-cost.history.jsonl');
  const histLine = JSON.stringify(summary) + '\n';
  if (existsSync(histPath)) {
    writeFileSync(histPath, readFileSync(histPath, 'utf8') + histLine, 'utf8');
  } else {
    writeFileSync(histPath, histLine, 'utf8');
  }

  console.log('');
  console.log('---------- summary ----------');
  console.log(`workload: ${results.length}/${WORKLOAD.length} queries`);
  console.log(
    `tier distribution: haiku=${tierCounts.haiku} sonnet=${tierCounts.sonnet} opus=${tierCounts.opus}`,
  );
  console.log(`routed total:  $${(Number(routedTotal) / 1e9).toFixed(6)}`);
  console.log(`opus total:    $${(Number(opusTotal) / 1e9).toFixed(6)}`);
  console.log(
    `savings:       $${(Number(savingsTotal) / 1e9).toFixed(6)} (${savingsPct.toFixed(1)}%)`,
  );
  console.log(`results: ${outPath}`);

  await pool.end();
}

main().catch((err) => {
  console.error('[measure] unhandled error:', err);
  process.exitCode = 1;
});
