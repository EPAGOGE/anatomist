import pg from 'pg';
import { createPostgresLedger, type PublicKeyResolver } from '@epagoge/ledger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const CHAIN_ID = 'reasoning-capture';
const LOCAL_USER_SOURCE_ID = 'local_user';

/**
 * Walks the reasoning-capture chain from head back to genesis. Verifies:
 *   - chain head exists for (reasoning-capture, local_user)
 *   - head_hash points to a real event
 *   - walking predecessors reaches an event with no predecessors (genesis)
 *   - the walk visits exactly head.eventCount events
 *   - verifyChain succeeds on the entire chain
 *
 * Skips (status:ok with detail) when the chain has no content yet — that's
 * the pre-backfill state.
 */
export function reasoningChainCheck(databaseUrl: string): Check {
  return makeCheck('reasoning-capture-chain-head', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const ledger = createPostgresLedger({ pool });

    try {
      const head = await ledger.getChainHead(CHAIN_ID, LOCAL_USER_SOURCE_ID);
      if (!head) {
        return 'chain empty (pre-backfill)';
      }

      const headEvent = await ledger.getEvent(head.headHash);
      if (!headEvent) {
        throw new Error(`head pointer references missing event ${head.headHash}`);
      }
      if (headEvent.causal_sequence_marker !== head.headSequenceMarker) {
        throw new Error(
          `head marker mismatch: head_row=${head.headSequenceMarker} vs event=${headEvent.causal_sequence_marker}`,
        );
      }

      // Walk the chain's BACKBONE — follow causal_predecessors[0] only.
      // This matters now that reasoning-capture events include cross-chain
      // refs in causal_predecessors[1..] (canvas-save reasoning events
      // point at the architecture-composition event hash per E2-1).
      // walkPredecessors does a BFS over all predecessors and would
      // traverse INTO the other chain via the cross-chain ref, inflating
      // the count. The chain's "events on this chain" is the linear
      // backbone walked via predecessors[0] only.
      let walked = 0;
      let foundGenesis = false;
      let cursor: string | null = head.headHash;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const event = await ledger.getEvent(cursor);
        if (!event) break;
        walked++;
        // Backbone = the first predecessor ON THIS CHAIN. Slot position is
        // not reliable at genesis: the first canvas-save event on an empty
        // chain has ONLY the cross-chain architecture ref in slot [0], so
        // slot-based walking would wander onto the other chain. Genesis is
        // therefore "no same-chain predecessor", not "no predecessors".
        let next: string | null = null;
        for (const pred of event.causal_predecessors) {
          const predEvent = await ledger.getEvent(pred);
          if (predEvent && predEvent.chain_id === CHAIN_ID) {
            next = pred;
            break;
          }
        }
        if (next === null) {
          foundGenesis = true;
          break;
        }
        cursor = next;
      }
      if (!foundGenesis) {
        throw new Error(`walk from head did not reach a genesis (no-predecessor) event`);
      }
      if (BigInt(walked) !== head.eventCount) {
        throw new Error(
          `walk visited ${walked} events but chain_head.event_count = ${head.eventCount}`,
        );
      }

      // Resolve the local user's public keys from the DB to re-verify the
      // entire chain.
      const db = drizzle(pool);
      const userRow = (
        await db.select().from(users).where(eq(users.sourceId, LOCAL_USER_SOURCE_ID)).limit(1)
      )[0];
      if (!userRow) {
        throw new Error(
          `user row for source_id=${LOCAL_USER_SOURCE_ID} missing; cannot verify chain signatures`,
        );
      }
      const resolver: PublicKeyResolver = async (sid) =>
        sid === LOCAL_USER_SOURCE_ID
          ? {
              pq: new Uint8Array(userRow.attestationPublicKeyPq),
              classical: new Uint8Array(userRow.attestationPublicKeyClassical),
            }
          : null;

      const verification = await ledger.verifyChain(CHAIN_ID, resolver, {
        sourceId: LOCAL_USER_SOURCE_ID,
      });
      if (!verification.ok) {
        throw new Error(
          `verifyChain reported failures: ${verification.failures
            .map((f) => `${f.reason}@${f.eventHash.slice(0, 12)}`)
            .join(', ')}`,
        );
      }

      return `${walked} events, walks to genesis, all signatures verify`;
    } finally {
      await ledger.close();
    }
  });
}
