// Emit lifecycle events to the system-operational chain.
//
// Per ADR-0013: chain initialization order requires that the
// reasoning-capture and system-operational chains exist (or be allowed to
// have their genesis appended) before the server is considered operational.
// This module's emitServerStarted is called BEFORE app.listen(); failure
// blocks server startup. emitServerStopped is best-effort during shutdown.

import { blake3 } from '@epagoge/crypto';
import {
  encodeCanonicalCbor,
  SystemOperationalPayloadSchema,
  type SystemOperationalPayload,
} from '@epagoge/shared';
import { signEvent, type LedgerHandle, type PublicKeyResolver } from '@epagoge/ledger';
import type { LocalIdentity } from '../identity/local-key-store.js';

const CHAIN_ID = 'system-operational';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface EmitContext {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  resolveKeys: PublicKeyResolver;
}

/**
 * Append a system-operational event to the chain. The payload is validated
 * against SystemOperationalPayloadSchema before encoding to guarantee shape
 * conformance — schema drift in this critical path becomes a load-time
 * failure rather than a silent encode.
 *
 * Returns the event hash on success; throws AppendError on validation
 * failure (signature, predecessor, marker, etc).
 */
export async function emitSystemOperationalEvent(
  ctx: EmitContext,
  payload: SystemOperationalPayload,
): Promise<string> {
  SystemOperationalPayloadSchema.parse(payload);

  const head = await ctx.ledger.getChainHead(CHAIN_ID, ctx.identity.sourceId);
  const nextMarker = head ? head.headSequenceMarker + 1n : 1n;
  const predecessors = head ? [head.headHash] : [];

  const payloadBytes = encodeCanonicalCbor(payload);
  const payloadIntegrity = bytesToHex(blake3.hash(payloadBytes));

  const event = await signEvent(
    {
      version: 1,
      chain_id: CHAIN_ID,
      event_type: 'system-operational',
      source_id: ctx.identity.sourceId,
      causal_predecessors: predecessors,
      absence_set_delta: [],
      source_reliability: 65535,
      causal_sequence_marker: nextMarker,
      ground_truth_calibration_indicator: undefined,
      payload_integrity: payloadIntegrity,
    },
    { pq: ctx.identity.mldsa, classical: ctx.identity.ed25519 },
  );

  return ctx.ledger.appendEvent(event, ctx.resolveKeys, { payload: payloadBytes });
}
