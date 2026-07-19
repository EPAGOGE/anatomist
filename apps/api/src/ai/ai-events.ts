// AI-interaction chain emission.
//
// Every Anthropic API call produces one signed event on the
// 'ai-interaction' chain. The orchestrator builds the
// AiInteractionDetails payload from cost + usage data; this module
// signs and appends.
//
// Chain mechanics mirror auth-events: linear, platform-owned, signed
// by the local platform identity, source_id = identity.sourceId.

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { blake3 } from '@epagoge/crypto';
import {
  signEvent,
  createPostgresLedger,
  type PublicKeyResolver,
  type LedgerHandle,
} from '@epagoge/ledger';
import {
  encodeCanonicalCbor,
  AiInteractionEventSchema,
  type AiInteractionEventPayload,
} from '@epagoge/shared';
import { chainOwners } from '../db/schema.js';
import type { LocalIdentity } from '../identity/local-key-store.js';

export const AI_INTERACTION_CHAIN_ID = 'ai-interaction';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Idempotent claim of the ai-interaction chain. Safe to call on boot. */
export async function ensureAiInteractionChain(pool: pg.Pool): Promise<void> {
  const db = drizzle(pool);
  const owner = await db
    .select()
    .from(chainOwners)
    .where(eq(chainOwners.chainId, AI_INTERACTION_CHAIN_ID))
    .limit(1);
  if (owner.length > 0) return;
  await db.insert(chainOwners).values({
    chainId: AI_INTERACTION_CHAIN_ID,
    ownerType: 'platform',
    ownerEntityId: 'platform',
  });
}

export interface AppendAiInteractionOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  payload: AiInteractionEventPayload;
}

export async function appendAiInteraction(options: AppendAiInteractionOptions): Promise<string> {
  AiInteractionEventSchema.parse(options.payload);
  const sourceId = options.identity.sourceId;

  const head = await options.ledger.getChainHead(AI_INTERACTION_CHAIN_ID, sourceId);
  const predecessors = head ? [head.headHash] : [];
  const marker = (head?.headSequenceMarker ?? 0n) + 1n;

  const payloadBytes = encodeCanonicalCbor(options.payload);
  const payloadIntegrity = bytesToHex(blake3.hash(payloadBytes));

  const resolver: PublicKeyResolver = async (sid) =>
    sid === sourceId
      ? {
          pq: options.identity.mldsa.publicKey,
          classical: options.identity.ed25519.publicKey,
        }
      : null;

  const event = await signEvent(
    {
      version: 1,
      chain_id: AI_INTERACTION_CHAIN_ID,
      event_type: 'synthetic-derived',
      source_id: sourceId,
      causal_predecessors: predecessors,
      absence_set_delta: [],
      source_reliability: 65535,
      causal_sequence_marker: marker,
      ground_truth_calibration_indicator: undefined,
      payload_integrity: payloadIntegrity,
    },
    { pq: options.identity.mldsa, classical: options.identity.ed25519 },
  );

  return options.ledger.appendEvent(event, resolver, { payload: payloadBytes });
}

/** One-shot helper that opens its own ledger handle. */
export async function appendAiInteractionWithPool(
  pool: pg.Pool,
  identity: LocalIdentity,
  payload: AiInteractionEventPayload,
): Promise<string> {
  const ledger = createPostgresLedger({ pool });
  try {
    return await appendAiInteraction({ ledger, identity, payload });
  } finally {
    await ledger.close();
  }
}
