// Auth-events chain emission.
//
// Every auth-significant action is recorded as a signed event on the
// 'auth-events' chain. Source_id is 'platform' for chain operations
// performed by the platform on behalf of a user (registration, login
// observation). The platform signs with the local platform identity
// (the same one used for system-operational events).
//
// Lifecycle:
//   ensureAuthEventsChain  -> idempotent setup of chain_owners row
//   appendAuthEvent        -> sign + append a single event, with
//                             predecessor = current chain head

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
  AuthEventPayloadSchema,
  type AuthEventPayload,
} from '@epagoge/shared';
import { chainOwners } from '../db/schema.js';
import type { LocalIdentity } from '../identity/local-key-store.js';

export const AUTH_EVENTS_CHAIN_ID = 'auth-events';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Idempotently claim the auth-events chain for platform ownership. Safe
 * to call on every server boot; no-op when the row already exists.
 */
export async function ensureAuthEventsChain(pool: pg.Pool): Promise<void> {
  const db = drizzle(pool);
  const owner = await db
    .select()
    .from(chainOwners)
    .where(eq(chainOwners.chainId, AUTH_EVENTS_CHAIN_ID))
    .limit(1);
  if (owner.length > 0) return;
  await db.insert(chainOwners).values({
    chainId: AUTH_EVENTS_CHAIN_ID,
    ownerType: 'platform',
    ownerEntityId: 'platform',
  });
}

export interface AppendAuthEventOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity; // the platform local identity, used as signer
  payload: AuthEventPayload;
}

/**
 * Sign and append one event to the auth-events chain. The chain is linear
 * (single platform signer), so each new event references the current
 * chain head by hash and increments the marker.
 *
 * Concurrency: the auth-events chain is shared across every auth flow
 * (register, login, logout, api-key emission). The ledger's appendEvent
 * uses `SELECT ... FOR UPDATE` on chain_heads inside its transaction, so
 * concurrent appenders are serialized — the second writer waits for the
 * first to commit, then sees the new head_marker and (correctly) throws
 * `sequence-marker-not-monotonic`. We retry on that error with a fresh
 * head read, cap at MAX_APPEND_RETRIES so a genuinely sick chain doesn't
 * hang the request — that's a doctor-detected condition, not a runtime
 * one to spin on. (Earlier this function also re-checked the head
 * pointer after a successful append to defend against silent orphans
 * under READ COMMITTED; that workaround was removed in tranche 5 when
 * the ledger started locking properly.)
 */
const MAX_APPEND_RETRIES = 8;

export async function appendAuthEvent(options: AppendAuthEventOptions): Promise<string> {
  AuthEventPayloadSchema.parse(options.payload);
  const sourceId = options.identity.sourceId;

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
    const head = await options.ledger.getChainHead(AUTH_EVENTS_CHAIN_ID, sourceId);
    const predecessors = head ? [head.headHash] : [];
    const marker = (head?.headSequenceMarker ?? 0n) + 1n;

    const event = await signEvent(
      {
        version: 1,
        chain_id: AUTH_EVENTS_CHAIN_ID,
        event_type: 'system-operational',
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
    : new Error('appendAuthEvent: exhausted retries on contended chain head');
}

/**
 * One-shot helper that opens its own ledger handle. Use this from contexts
 * (HTTP handlers, lifecycle hooks) that don't already hold a long-lived
 * ledger reference.
 */
export async function appendAuthEventWithPool(
  pool: pg.Pool,
  identity: LocalIdentity,
  payload: AuthEventPayload,
): Promise<string> {
  const ledger = createPostgresLedger({ pool });
  try {
    return await appendAuthEvent({ ledger, identity, payload });
  } finally {
    await ledger.close();
  }
}
