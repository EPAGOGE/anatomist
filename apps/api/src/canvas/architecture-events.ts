// Architecture-composition chain emission.
//
// Each canvas save lands a signed event on the per-user
// 'architecture-composition:<user_uuid>' chain. Pattern matches
// auth-events: the platform identity signs (per ADR-0008, AI never
// touches the reliability path; the user's secret key is envelope-
// encrypted and decrypting it on every save is operationally heavy).
// User attribution lives in the payload (`architecture_id`) and in
// chain ownership (`chain_owners.owner_entity_id = user_uuid`).
//
// Phase 0 sub-phase E. Eventual user-attested signatures (proof "I
// really made this") are a Phase 1 enhancement.

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { blake3 } from '@epagoge/crypto';
import {
  signEvent,
  type PublicKeyResolver,
  type LedgerHandle,
  architectureCompositionChainId,
} from '@epagoge/ledger';
import {
  encodeCanonicalCbor,
  ArchitectureCompositionPayloadSchema,
  type ArchitectureCompositionPayload,
} from '@epagoge/shared';
import { chainOwners } from '../db/schema.js';
import type { LocalIdentity } from '../identity/local-key-store.js';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Idempotently claim the per-user architecture-composition chain.
 * Called from the save route before the first append; no-op on
 * subsequent saves.
 */
export async function ensureArchitectureChain(pool: pg.Pool, userId: string): Promise<void> {
  const db = drizzle(pool);
  const chainId = architectureCompositionChainId(userId);
  const existing = await db
    .select()
    .from(chainOwners)
    .where(eq(chainOwners.chainId, chainId))
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(chainOwners).values({
    chainId,
    ownerType: 'user',
    ownerEntityId: userId,
  });
}

export interface AppendArchitectureEventOptions {
  ledger: LedgerHandle;
  /** Platform identity that signs the event. */
  identity: LocalIdentity;
  /** UUID of the user the chain belongs to. */
  userId: string;
  /** Validated payload. */
  payload: ArchitectureCompositionPayload;
}

/**
 * Sign and append one event to the user's architecture-composition
 * chain. Uses the same retry-on-monotonic-violation pattern as
 * auth-events (the ledger FOR UPDATE lock means writers wait their
 * turn and the second one cleanly throws when the first commits).
 */
const MAX_APPEND_RETRIES = 8;

export async function appendArchitectureEvent(
  options: AppendArchitectureEventOptions,
): Promise<string> {
  ArchitectureCompositionPayloadSchema.parse(options.payload);
  const sourceId = options.identity.sourceId;
  const chainId = architectureCompositionChainId(options.userId);

  const payloadBytes = encodeCanonicalCbor(options.payload);
  const payloadIntegrity = bytesToHex(blake3.hash(payloadBytes));

  const resolver: PublicKeyResolver = async (sid) =>
    sid === sourceId
      ? {
          pq: options.identity.mldsa.publicKey,
          classical: options.identity.ed25519.publicKey,
        }
      : null;

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    const head = await options.ledger.getChainHead(chainId, sourceId);
    const predecessors = head ? [head.headHash] : [];
    const marker = (head?.headSequenceMarker ?? 0n) + 1n;

    const event = await signEvent(
      {
        version: 1,
        chain_id: chainId,
        event_type: 'user-generated',
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

    try {
      return await options.ledger.appendEvent(event, resolver, { payload: payloadBytes });
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const retriable = /sequence-marker-not-monotonic|predecessor-marker-violation/.test(message);
      if (!retriable) throw err;
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 15)));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('appendArchitectureEvent: exhausted retries on contended chain head');
}

/**
 * Look up all event hashes on a user's architecture-composition
 * chain. Used by the list endpoint. Walks head → genesis collecting
 * one entry per event.
 */
export async function listUserArchitectureEvents(options: {
  ledger: LedgerHandle;
  userId: string;
  identity: LocalIdentity;
  limit?: number;
}): Promise<Array<{ eventHash: string; causalSequenceMarker: bigint }>> {
  const chainId = architectureCompositionChainId(options.userId);
  const head = await options.ledger.getChainHead(chainId, options.identity.sourceId);
  if (!head) return [];
  const out: Array<{ eventHash: string; causalSequenceMarker: bigint }> = [];
  const limit = options.limit ?? 200;
  let cursor: string | null = head.headHash;
  while (cursor && out.length < limit) {
    const ev = await options.ledger.getEvent(cursor);
    if (!ev) break;
    out.push({ eventHash: cursor, causalSequenceMarker: ev.causal_sequence_marker });
    cursor = ev.causal_predecessors.length > 0 ? ev.causal_predecessors[0]! : null;
  }
  return out;
}

/**
 * Verify that a given event belongs to the user's
 * architecture-composition chain, and use the helpers to fetch its
 * decoded payload.
 *
 * The (chain_id, user_id) check guards against a user replaying
 * someone else's architecture by guessing the event hash.
 */
export async function getUserArchitectureEvent(options: {
  ledger: LedgerHandle;
  userId: string;
  eventHash: string;
}): Promise<{ payload: ArchitectureCompositionPayload; causalSequenceMarker: bigint } | null> {
  const chainId = architectureCompositionChainId(options.userId);
  const ev = await options.ledger.getEvent(options.eventHash);
  if (!ev) return null;
  if (ev.chain_id !== chainId) return null;
  const bytes = await options.ledger.getEventPayload(options.eventHash);
  if (!bytes) return null;
  // Decode + re-validate against the schema so a future on-disk drift
  // surfaces here rather than blowing up downstream.
  const { decodeCbor } = await import('@epagoge/shared');
  const decoded = decodeCbor<unknown>(new Uint8Array(bytes));
  const parsed = ArchitectureCompositionPayloadSchema.safeParse(decoded);
  if (!parsed.success) return null;
  return { payload: parsed.data, causalSequenceMarker: ev.causal_sequence_marker };
}
