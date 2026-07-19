// Doctor check #29: cross-chain provenance lint.
//
// Per ADR-0023 + ADR-0025, ai-interaction events can record cross-chain
// references via `context_selection.included_chain_events` — an array
// of event hashes pointing at OTHER chains the AI response drew on
// (e.g., a chat answer that referenced a reasoning-capture ADR).
//
// These references are NOT enforced as foreign keys (the chain layer
// doesn't have referential integrity in the relational sense — the
// references are just hash values embedded in CBOR payloads). A typo,
// a chain rebuild, or a future chain garbage-collection pass could
// orphan a reference. This check is the tripwire.
//
// What it does:
//   1. Walks every ai-interaction event from head.
//   2. Decodes payload, extracts context_selection.included_chain_events.
//   3. For each referenced hash, asserts an event row exists in the
//      events table.
//   4. Reports dangling references with their source events.
//
// Phase 0 is forgiving: zero AI events means nothing to lint, and the
// check returns ok. As ai-interaction chain grows, the check becomes a
// real auditor.

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq, inArray } from 'drizzle-orm';
import { createPostgresLedger } from '@epagoge/ledger';
import { decodeCbor, AiInteractionEventSchema } from '@epagoge/shared';
import { events, chainHeads } from '../../db/schema.js';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

export function crossChainProvenanceCheck(databaseUrl: string): Check {
  return makeCheck('cross-chain-provenance-lint', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const ledger = createPostgresLedger({ pool });
    try {
      const db = drizzle(pool);

      // Find the ai-interaction chain head across any source.
      const head = (
        await db
          .select()
          .from(chainHeads)
          .where(eq(chainHeads.chainId, 'ai-interaction'))
          .orderBy(desc(chainHeads.headSequenceMarker))
          .limit(1)
      )[0];
      if (!head) {
        return 'ai-interaction chain empty (no AI calls yet — nothing to lint)';
      }

      // Walk head → genesis, collecting all referenced hashes.
      const referencedHashes = new Set<string>();
      const referencesBySource: Array<{ source: string; ref: string }> = [];
      let cursor: string | null = head.headHash;
      let walked = 0;
      while (cursor) {
        walked++;
        const event = await ledger.getEvent(cursor);
        if (!event) break;
        const payload = await ledger.getEventPayload(cursor);
        if (payload) {
          try {
            const decoded = decodeCbor<unknown>(payload);
            const parsed = AiInteractionEventSchema.safeParse(decoded);
            if (parsed.success) {
              const refs = parsed.data.details.context_selection?.included_chain_events ?? [];
              for (const ref of refs) {
                referencedHashes.add(ref);
                referencesBySource.push({ source: cursor, ref });
              }
            }
          } catch {
            // Non-AI-interaction payload; skip.
          }
        }
        cursor = event.causal_predecessors.length > 0 ? event.causal_predecessors[0]! : null;
      }

      if (referencedHashes.size === 0) {
        return `walked ${walked} ai-interaction events; no cross-chain references found`;
      }

      // Look up which of the referenced hashes actually exist.
      const present = await db
        .select({ eventHash: events.eventHash })
        .from(events)
        .where(inArray(events.eventHash, Array.from(referencedHashes)));
      const presentSet = new Set(present.map((r) => r.eventHash));

      const dangling = referencesBySource.filter(({ ref }) => !presentSet.has(ref));
      if (dangling.length > 0) {
        const sample = dangling
          .slice(0, 3)
          .map((d) => `${d.source.slice(0, 8)}…→${d.ref.slice(0, 8)}…`)
          .join(', ');
        throw new Error(
          `${dangling.length} dangling cross-chain reference${dangling.length === 1 ? '' : 's'}: ${sample}${
            dangling.length > 3 ? ` (+${dangling.length - 3} more)` : ''
          }`,
        );
      }

      return `walked ${walked} ai-interaction events, ${referencedHashes.size} cross-chain references all resolve`;
    } finally {
      await ledger.close();
    }
  });
}
