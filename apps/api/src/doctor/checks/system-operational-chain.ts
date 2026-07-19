import pg from 'pg';
import { createPostgresLedger, type PublicKeyResolver } from '@epagoge/ledger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const CHAIN_ID = 'system-operational';
const LOCAL_USER_SOURCE_ID = 'local_user';

/**
 * Same pattern as reasoning-capture-chain-head — validates the
 * system-operational chain head pointer, walks to genesis, and re-verifies
 * every signature. Returns 'chain empty (pre-first-startup)' when no
 * events have been emitted yet (e.g., before any server boot).
 */
export function systemOperationalChainCheck(databaseUrl: string): Check {
  return makeCheck('system-operational-chain-head', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const ledger = createPostgresLedger({ pool });

    try {
      const head = await ledger.getChainHead(CHAIN_ID, LOCAL_USER_SOURCE_ID);
      if (!head) {
        return 'chain empty (pre-first-startup)';
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

      let walked = 0;
      let foundGenesis = false;
      for await (const event of ledger.walkPredecessors(head.headHash)) {
        walked++;
        if (event.causal_predecessors.length === 0) {
          foundGenesis = true;
        }
      }
      if (!foundGenesis) {
        throw new Error('walk from head did not reach a genesis (no-predecessor) event');
      }
      if (BigInt(walked) !== head.eventCount) {
        throw new Error(
          `walk visited ${walked} events but chain_head.event_count = ${head.eventCount}`,
        );
      }

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
