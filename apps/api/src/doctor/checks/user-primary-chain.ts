import pg from 'pg';
import { createPostgresLedger, userPrimaryChainId, type PublicKeyResolver } from '@epagoge/ledger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { users, chainOwners } from '../../db/schema.js';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const LOCAL_USER_SOURCE_ID = 'local_user';

/**
 * Validates the local user's user-primary chain end-to-end. Phase 0 only
 * has one user, so this check targets it specifically; Phase 1+ will
 * generalize to iterate over every user-owned chain.
 *
 * Checks:
 *   - users row exists for local_user
 *   - chain_owners row exists for the constructed chain_id
 *   - chain head exists and points to a real event
 *   - walk reaches genesis, event count consistent
 *   - full verifyChain succeeds
 *
 * Returns 'no local user yet' as a successful detail when the user hasn't
 * been seeded — fresh DB state.
 */
export function userPrimaryChainCheck(databaseUrl: string): Check {
  return makeCheck('user-primary-chain-head', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const ledger = createPostgresLedger({ pool });

    try {
      const db = drizzle(pool);
      const userRow = (
        await db.select().from(users).where(eq(users.sourceId, LOCAL_USER_SOURCE_ID)).limit(1)
      )[0];
      if (!userRow) {
        return 'no local user yet';
      }
      const chainId = userPrimaryChainId(userRow.id);

      const ownerRow = (
        await db.select().from(chainOwners).where(eq(chainOwners.chainId, chainId)).limit(1)
      )[0];
      if (!ownerRow) {
        throw new Error(`chain_owners row missing for ${chainId}`);
      }
      if (ownerRow.ownerType !== 'user' || ownerRow.ownerEntityId !== userRow.id) {
        throw new Error(
          `chain ${chainId} owner mismatch: ${ownerRow.ownerType}/${ownerRow.ownerEntityId}`,
        );
      }

      const head = await ledger.getChainHead(chainId, LOCAL_USER_SOURCE_ID);
      if (!head) {
        throw new Error(`chain_heads row missing for ${chainId} / ${LOCAL_USER_SOURCE_ID}`);
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
        if (event.causal_predecessors.length === 0) foundGenesis = true;
      }
      if (!foundGenesis) {
        throw new Error('walk from head did not reach a genesis (no-predecessor) event');
      }
      if (BigInt(walked) !== head.eventCount) {
        throw new Error(
          `walk visited ${walked} events but chain_head.event_count = ${head.eventCount}`,
        );
      }

      const resolver: PublicKeyResolver = async (sid) =>
        sid === LOCAL_USER_SOURCE_ID
          ? {
              pq: new Uint8Array(userRow.attestationPublicKeyPq),
              classical: new Uint8Array(userRow.attestationPublicKeyClassical),
            }
          : null;
      const verification = await ledger.verifyChain(chainId, resolver, {
        sourceId: LOCAL_USER_SOURCE_ID,
      });
      if (!verification.ok) {
        throw new Error(
          `verifyChain reported failures: ${verification.failures
            .map((f) => `${f.reason}@${f.eventHash.slice(0, 12)}`)
            .join(', ')}`,
        );
      }

      return `${walked} events on ${chainId.slice(0, 28)}..., walks to genesis, all signatures verify`;
    } finally {
      await ledger.close();
    }
  });
}
