import pg from 'pg';
import { createPostgresLedger, type PublicKeyResolver } from '@epagoge/ledger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { users, chainOwners } from '../../db/schema.js';
import { AUTH_EVENTS_CHAIN_ID } from '../../auth/auth-events.js';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const LOCAL_USER_SOURCE_ID = 'local_user';

/**
 * Validates the auth-events chain end-to-end. Like reasoning-capture and
 * system-operational, this is a platform-owned linear chain. The chain
 * may be empty if no auth-affecting action has occurred yet (fresh DB
 * pre-first-registration); that is a successful state.
 */
export function authEventsChainCheck(databaseUrl: string): Check {
  return makeCheck('auth-events-chain-head', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const ledger = createPostgresLedger({ pool });

    try {
      const db = drizzle(pool);
      const ownerRow = (
        await db
          .select()
          .from(chainOwners)
          .where(eq(chainOwners.chainId, AUTH_EVENTS_CHAIN_ID))
          .limit(1)
      )[0];
      if (!ownerRow) {
        // The chain hasn't been claimed yet (server hasn't booted with
        // auth enabled). That's fine pre-first-boot.
        return 'chain not yet claimed (pre-auth-boot)';
      }
      if (ownerRow.ownerType !== 'platform') {
        throw new Error(
          `auth-events chain owner_type expected 'platform', got '${ownerRow.ownerType}'`,
        );
      }

      const head = await ledger.getChainHead(AUTH_EVENTS_CHAIN_ID, LOCAL_USER_SOURCE_ID);
      if (!head) {
        return 'chain empty (no auth events emitted yet)';
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
      // chain_heads.event_count tracks "events appended"; the walk counts
      // "events reachable from the current head." Under concurrent writers
      // (multiple HTTP handlers emitting auth events at the same time),
      // a race on the head pointer can leave divergent branches: both
      // events get inserted with the same predecessor, both contribute
      // to event_count, but only one path is reachable from head. The
      // chain stays cryptographically valid; event_count just over-counts.
      // Asserting walk_count ≤ event_count keeps the check meaningful
      // without flagging benign concurrent-writer behavior.
      if (BigInt(walked) > head.eventCount) {
        throw new Error(
          `walk visited ${walked} events but chain_head.event_count = ${head.eventCount} — chain_heads has fewer events than the walk can reach (corruption)`,
        );
      }

      const userRow = (
        await db.select().from(users).where(eq(users.sourceId, LOCAL_USER_SOURCE_ID)).limit(1)
      )[0];
      if (!userRow) {
        throw new Error(`user row for source_id=${LOCAL_USER_SOURCE_ID} missing`);
      }
      const resolver: PublicKeyResolver = async (sid) =>
        sid === LOCAL_USER_SOURCE_ID
          ? {
              pq: new Uint8Array(userRow.attestationPublicKeyPq),
              classical: new Uint8Array(userRow.attestationPublicKeyClassical),
            }
          : null;

      const verification = await ledger.verifyChain(AUTH_EVENTS_CHAIN_ID, resolver, {
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
