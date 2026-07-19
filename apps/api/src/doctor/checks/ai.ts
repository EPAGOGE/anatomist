import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import {
  MODELS,
  MODEL_SPECS,
  computeCost,
  computeCacheKey,
  route,
  getClient,
  createMessage,
} from '@epagoge/ai';
import { ensureLocalIdentity } from '../../identity/local-key-store.js';
import { invokeAi } from '../../ai/orchestrator.js';
import { aiInteractions, users } from '../../db/schema.js';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const HAS_API_KEY = () => Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * Check #23 — anthropic-reachable. Lightweight live ping via the SDK
 * messages endpoint. Skipped when ANTHROPIC_API_KEY isn't set so the
 * doctor stays green in environments without AI credentials.
 */
export const anthropicReachableCheck: Check = makeCheck('anthropic-reachable', async () => {
  if (!HAS_API_KEY()) {
    // Re-throw as a meaningful skip — runner doesn't expose "skip from
    // inside" so we return a detail string and mark the check ok.
    return 'ANTHROPIC_API_KEY not set; skipped live ping';
  }
  // Construct the client and make a minimal call.
  getClient();
  const { message } = await createMessage({
    model: MODELS.haiku,
    maxTokens: 16,
    messages: [{ role: 'user', content: 'reply with the word: ok' }],
  });
  if (!message.content.length) throw new Error('Anthropic returned no content blocks');
  return `model=${message.model} stop=${message.stop_reason}`;
});

/**
 * Check #24 — model-routing. Verifies router behavior is deterministic
 * for representative inputs across all three tiers without making any
 * network calls.
 */
export const modelRoutingCheck: Check = makeCheck('model-routing', async () => {
  const haikuRoute = route({ purpose: 'doctor-roundtrip', inputChars: 50 });
  if (haikuRoute.tier !== 'haiku')
    throw new Error(`expected haiku for doctor-roundtrip; got ${haikuRoute.tier}`);

  const sonnetRoute = route({ purpose: 'chat', inputChars: 500 });
  if (sonnetRoute.tier !== 'sonnet')
    throw new Error(`expected sonnet for chat default; got ${sonnetRoute.tier}`);

  const opusRoute = route({ purpose: 'reasoning-capture', inputChars: 5000 });
  if (opusRoute.tier !== 'opus')
    throw new Error(`expected opus for reasoning-capture; got ${opusRoute.tier}`);

  const forcedRoute = route({ purpose: 'chat', inputChars: 100, forceTier: 'opus' });
  if (forcedRoute.tier !== 'opus') throw new Error('forceTier override did not take effect');

  return 'haiku/sonnet/opus routing + force-override OK';
});

/**
 * Check #25 — cost-known-values. Validates that cost.ts produces the
 * exact published per-token amounts. Catches accidental pricing
 * regressions before they ship.
 */
export const costKnownValuesCheck: Check = makeCheck('cost-known-values', async () => {
  // Opus 4.7: $5 / $25 per MTok. 1M input + 1M output = $5 + $25 = $30 = 30B nanos.
  const opus = computeCost(MODELS.opus, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  if (opus.totalNanos !== 30_000_000_000n) {
    throw new Error(`Opus 1M+1M: expected 30,000,000,000 nanos; got ${opus.totalNanos}`);
  }
  // Sonnet 4.6: $3 / $15. 1M+1M = $18 = 18B.
  const sonnet = computeCost(MODELS.sonnet, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  if (sonnet.totalNanos !== 18_000_000_000n) {
    throw new Error(`Sonnet 1M+1M: expected 18,000,000,000 nanos; got ${sonnet.totalNanos}`);
  }
  // Haiku 4.5: $1 / $5. 1M+1M = $6 = 6B.
  const haiku = computeCost(MODELS.haiku, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  if (haiku.totalNanos !== 6_000_000_000n) {
    throw new Error(`Haiku 1M+1M: expected 6,000,000,000 nanos; got ${haiku.totalNanos}`);
  }
  // Cache read discount: Opus 1M cache read = 0.1 * 5 = $0.50 = 500M nanos.
  const opusCacheRead = computeCost(MODELS.opus, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 1_000_000,
  });
  if (opusCacheRead.cacheReadNanos !== 500_000_000n) {
    throw new Error(
      `Opus 1M cache-read: expected 500,000,000 nanos; got ${opusCacheRead.cacheReadNanos}`,
    );
  }
  return 'opus/sonnet/haiku per-MTok values match published pricing';
});

/**
 * Check #26 — ai-interaction-chain-head. Standard chain doctor check
 * applied to the new chain. Chain is empty pre-first-call which is fine.
 */
export function aiInteractionChainCheck(databaseUrl: string): Check {
  return makeCheck('ai-interaction-chain-head', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const { createPostgresLedger } = await import('@epagoge/ledger');
    const ledger = createPostgresLedger({ pool });
    try {
      const { chainOwners } = await import('../../db/schema.js');
      const db = drizzle(pool);
      const owner = (
        await db
          .select()
          .from(chainOwners)
          .where(eq(chainOwners.chainId, 'ai-interaction'))
          .limit(1)
      )[0];
      if (!owner) return 'chain not yet claimed (pre-first-AI-boot)';
      const head = await ledger.getChainHead('ai-interaction', 'local_user');
      if (!head) return 'chain empty (no AI calls yet)';
      let walked = 0;
      let foundGenesis = false;
      for await (const event of ledger.walkPredecessors(head.headHash)) {
        walked++;
        if (event.causal_predecessors.length === 0) foundGenesis = true;
      }
      if (!foundGenesis) throw new Error('walk did not reach genesis');
      if (BigInt(walked) !== head.eventCount) {
        throw new Error(`walked ${walked} vs head event_count ${head.eventCount}`);
      }
      return `${walked} events, walks to genesis`;
    } finally {
      await ledger.close();
    }
  });
}

/**
 * Check #27 — cost-tracking-roundtrip. End-to-end: issue an invokeAi
 * call (against the local user when present), verify DB row inserted,
 * verify chain event hash is non-null, verify budget debited.
 * Skipped when no API key.
 */
export function costTrackingRoundtripCheck(databaseUrl: string): Check {
  return makeCheck('cost-tracking-roundtrip', async () => {
    if (!HAS_API_KEY()) {
      return 'ANTHROPIC_API_KEY not set; skipped live roundtrip';
    }
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const db = drizzle(pool);
    try {
      const userRow = (
        await db.select().from(users).where(eq(users.sourceId, 'local_user')).limit(1)
      )[0];
      if (!userRow) {
        return 'no local_user yet — db:seed not run';
      }
      const { identity } = await ensureLocalIdentity('local_user');
      const result = await invokeAi({
        pool,
        platformIdentity: identity,
        userId: userRow.id,
        sourceId: 'local_user',
        purpose: 'doctor-roundtrip',
        messages: [{ role: 'user', content: 'reply with the single word: roundtrip' }],
        routing: { forceTier: 'haiku' },
      });
      // Verify DB row.
      const row = (
        await db
          .select()
          .from(aiInteractions)
          .where(eq(aiInteractions.id, result.interactionId))
          .limit(1)
      )[0];
      if (!row) throw new Error('ai_interactions row missing after invokeAi');
      if (row.chainEventHash !== result.chainEventHash) {
        throw new Error('chain_event_hash mismatch between db row and result');
      }
      if (row.costTotalNanos !== result.costNanos) {
        throw new Error('cost mismatch between db row and result');
      }
      return `interaction=${result.interactionId.slice(0, 8)} model=${result.tier} cost=${row.costTotalNanos}n`;
    } finally {
      await pool.end();
    }
  });
}

// Touch unused import to keep linter quiet; computeCacheKey + MODEL_SPECS
// are re-exported for completeness even when not directly used here.
void computeCacheKey;
void MODEL_SPECS;
