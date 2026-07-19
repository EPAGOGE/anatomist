// Reasoning-capture emission for canvas saves.
//
// Per forward-design notes discipline: reasoning capture is active from
// Phase 0 and "the platform's own creation generates reasoning records."
// A canvas save is exactly the kind of substantive user activity that
// warrants a record: the user just committed to a particular structural
// composition.
//
// Pattern (per the user's E2 brief): every canvas save produces TWO
// signed chain events:
//   1. The architecture-composition event on the per-user chain (the
//      graph itself — appended by `appendArchitectureEvent`).
//   2. A reasoning-capture event on the shared reasoning-capture chain
//      (this module). Cross-referenced through `causal_predecessors`:
//      slot [0] is the reasoning-chain backbone (prior reasoning head);
//      slot [1] is the architecture-composition event hash (cross-chain
//      provenance pointer per ADR-0011 / doctor check #29).
//
// Schema: reuse the existing ReasoningRecord shape. decision_id is
// derived from architecture_id + the save's chain marker so each save
// has a deterministic, lookup-able id (CANVAS-<8>-<8>-<marker>).

import { signEvent, type LedgerHandle, type PublicKeyResolver } from '@epagoge/ledger';
import { encodeCanonicalCbor, ReasoningRecordSchema, type ReasoningRecord } from '@epagoge/shared';
import { blake3 } from '@epagoge/crypto';
import type { LocalIdentity } from '../identity/local-key-store.js';

export const REASONING_CAPTURE_CHAIN_ID = 'reasoning-capture';
const LOCAL_USER_SOURCE_ID = 'local_user';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AppendCanvasReasoningOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  userId: string;
  architectureId: string;
  architectureEventHash: string;
  architectureMarker: bigint;
  name: string;
  description: string | undefined;
  nodeCount: number;
  edgeCount: number;
  occurredAt: string;
}

/**
 * Build a `ReasoningRecord` for a canvas save and append it to the
 * reasoning-capture chain. Returns the resulting event hash.
 *
 * The record is intentionally lean. Canvas saves don't carry the
 * alternatives/trade-offs/future-implications structure ADRs do —
 * the user just committed to a state. What matters is the
 * cross-chain pointer and the deterministic decision_id.
 *
 * Architecture marker is the per-save sequence on the user's
 * architecture-composition chain (1, 2, 3, ...). It anchors the
 * decision_id so multiple saves of the same architecture_id are
 * distinguishable.
 */
export async function appendCanvasSaveReasoning(
  options: AppendCanvasReasoningOptions,
): Promise<string> {
  const decisionId = `CANVAS-${options.architectureId.slice(0, 8)}-${options.userId.slice(0, 8)}-${options.architectureMarker.toString()}`;

  const record: ReasoningRecord = {
    decision_id: decisionId,
    decision_date: options.occurredAt,
    decision_summary: `Canvas save: "${options.name}" (${options.nodeCount} nodes, ${options.edgeCount} edges)`,
    alternatives_considered: [],
    trade_offs_weighed: [],
    reasoning:
      options.description && options.description.trim().length > 0
        ? options.description.trim()
        : `User committed canvas state at sequence ${options.architectureMarker} of the ` +
          `architecture-composition chain. Full graph is signed under event ${options.architectureEventHash}.`,
    future_implications: [],
    related_decisions: [],
    implementation_location: [
      `architecture-composition:${options.userId}`,
      `event:${options.architectureEventHash}`,
    ],
    reviewer_attestation: {
      kind: 'human',
      reviewer_id: options.userId,
      note: 'User canvas save; platform attestation via local identity.',
    },
    revisability: 'flexible',
  };

  // Validate before signing so a schema drift here fails loudly rather
  // than producing a broken chain event.
  ReasoningRecordSchema.parse(record);

  const payloadBytes = encodeCanonicalCbor(record);
  const payloadIntegrity = bytesToHex(blake3.hash(payloadBytes));

  const resolver: PublicKeyResolver = async (sid) =>
    sid === options.identity.sourceId
      ? { pq: options.identity.mldsa.publicKey, classical: options.identity.ed25519.publicKey }
      : null;

  // Retry on monotonic violation. Same pattern as auth-events: ledger
  // FOR UPDATE serializes writers, the loser sees the new head, throws
  // sequence-marker-not-monotonic, retries with a fresh head.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    const head = await options.ledger.getChainHead(
      REASONING_CAPTURE_CHAIN_ID,
      LOCAL_USER_SOURCE_ID,
    );

    // causal_predecessors:
    //   [0] = reasoning-capture chain backbone (linear ordering)
    //   [1] = the architecture-composition event hash (cross-chain ref)
    const predecessors = head
      ? [head.headHash, options.architectureEventHash]
      : [options.architectureEventHash];
    // The ledger requires marker > EVERY predecessor's marker. One predecessor
    // is the cross-chain architecture event, which sits on the faster-growing
    // architecture-composition chain — so the reasoning marker must clear both
    // the reasoning-chain head AND the architecture event's marker, not just
    // the local head. (Genesis case: head is null but the architecture event
    // is already at marker N>1, so a naive marker=1 violates the invariant.)
    const reasoningHead = head?.headSequenceMarker ?? 0n;
    const floor =
      reasoningHead > options.architectureMarker ? reasoningHead : options.architectureMarker;
    const marker = floor + 1n;

    const event = await signEvent(
      {
        version: 1,
        chain_id: REASONING_CAPTURE_CHAIN_ID,
        event_type: 'user-generated',
        source_id: options.identity.sourceId,
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
    : new Error('appendCanvasSaveReasoning: exhausted retries');
}
