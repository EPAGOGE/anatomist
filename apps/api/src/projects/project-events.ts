// Project lifecycle chain emission — F-0 Criterion 1, ADR-0036.
//
// Project-created and project-lifecycle-updated events land on the
// user-primary chain (the chain that was claimed at registration). A
// single chain inventory absorbs project lifecycle without
// proliferating per-project chains.
//
// The pattern mirrors apps/api/src/canvas/architecture-events.ts:
// retry-on-monotonic-violation, FOR UPDATE serialization on the head
// (handled by the ledger), CBOR-canonical payload encoding, signed
// hybrid attestation. The chain event hash is returned so the caller
// can write it back to the projects row (creation_event_hash) for
// bidirectional reference per ADR-0017.

import {
  signEvent,
  userPrimaryChainId,
  type LedgerHandle,
  type PublicKeyResolver,
} from '@epagoge/ledger';
import {
  encodeCanonicalCbor,
  ProjectCreatedPayloadSchema,
  ProjectLifecycleUpdatedPayloadSchema,
  DatasetReferencedPayloadSchema,
  DatasetReferenceRemovedPayloadSchema,
  CodeExportedPayloadSchema,
  type ProjectCreatedPayload,
  type ProjectLifecycleUpdatedPayload,
  type DatasetReferencedPayload,
  type DatasetReferenceRemovedPayload,
  type CodeExportedPayload,
} from '@epagoge/shared';
import { blake3 } from '@epagoge/crypto';
import type { LocalIdentity } from '../identity/local-key-store.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_APPEND_RETRIES = 8;

export interface AppendProjectCreatedOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  /** UUID of the user the chain belongs to. */
  userId: string;
  /** Validated payload describing the new project. */
  payload: ProjectCreatedPayload;
}

/**
 * Sign and append a project-created event to the user-primary chain.
 * Returns the event hash so the projects row can record it.
 */
export async function appendProjectCreated(options: AppendProjectCreatedOptions): Promise<string> {
  ProjectCreatedPayloadSchema.parse(options.payload);
  return appendProjectEvent(options.ledger, options.identity, options.userId, options.payload);
}

export interface AppendProjectLifecycleUpdatedOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  userId: string;
  payload: ProjectLifecycleUpdatedPayload;
}

/**
 * Sign and append a project-lifecycle-updated event to the
 * user-primary chain.
 */
export async function appendProjectLifecycleUpdated(
  options: AppendProjectLifecycleUpdatedOptions,
): Promise<string> {
  ProjectLifecycleUpdatedPayloadSchema.parse(options.payload);
  return appendProjectEvent(options.ledger, options.identity, options.userId, options.payload);
}

export interface AppendDatasetReferencedOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  userId: string;
  payload: DatasetReferencedPayload;
}

/**
 * Sign and append a dataset-referenced event to the user-primary
 * chain. F-0 Task 105. Category 1 emission per ADR-0039 — the user
 * has stated a provenance claim about which dataset their project
 * intends to use.
 */
export async function appendDatasetReferenced(
  options: AppendDatasetReferencedOptions,
): Promise<string> {
  DatasetReferencedPayloadSchema.parse(options.payload);
  return appendProjectEvent(options.ledger, options.identity, options.userId, options.payload);
}

export interface AppendDatasetReferenceRemovedOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  userId: string;
  payload: DatasetReferenceRemovedPayload;
}

/**
 * Sign and append a dataset-reference-removed event to the user-
 * primary chain. F-0 Task 105. Category 1 emission with compensating-
 * event semantics per ADR-0039 D.11: the removal references the
 * original via `original_event_hash` and does NOT rewrite history.
 */
export async function appendDatasetReferenceRemoved(
  options: AppendDatasetReferenceRemovedOptions,
): Promise<string> {
  DatasetReferenceRemovedPayloadSchema.parse(options.payload);
  return appendProjectEvent(options.ledger, options.identity, options.userId, options.payload);
}

export interface AppendCodeExportedOptions {
  ledger: LedgerHandle;
  identity: LocalIdentity;
  userId: string;
  payload: CodeExportedPayload;
}

/**
 * Sign and append a code-exported event to the user-primary chain.
 * F-0 Task 106. Category 1 emission per ADR-0039 — the user has
 * pushed generated code from one of their attested architectures to
 * an external destination, creating the platform's distinctive
 * verifiable provenance claim linking attested architecture to
 * external commit SHA.
 *
 * Unlike dataset-referenced (Task 105) which is idempotent on
 * same-active-claim, code-exported is NOT idempotent — every
 * export is its own provenance claim and gets its own chain event.
 */
export async function appendCodeExported(options: AppendCodeExportedOptions): Promise<string> {
  CodeExportedPayloadSchema.parse(options.payload);
  return appendProjectEvent(options.ledger, options.identity, options.userId, options.payload);
}

// Shared append logic — both event kinds use the same chain, same
// retry pattern, same signing. Mirrors apps/api/src/canvas/architecture-events.ts.
async function appendProjectEvent(
  ledger: LedgerHandle,
  identity: LocalIdentity,
  userId: string,
  payload:
    | ProjectCreatedPayload
    | ProjectLifecycleUpdatedPayload
    | DatasetReferencedPayload
    | DatasetReferenceRemovedPayload
    | CodeExportedPayload,
): Promise<string> {
  const sourceId = identity.sourceId;
  const chainId = userPrimaryChainId(userId);

  const payloadBytes = encodeCanonicalCbor(payload);
  const payloadIntegrity = bytesToHex(blake3.hash(payloadBytes));

  const resolver: PublicKeyResolver = async (sid) =>
    sid === sourceId
      ? {
          pq: identity.mldsa.publicKey,
          classical: identity.ed25519.publicKey,
        }
      : null;

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    const head = await ledger.getChainHead(chainId, sourceId);
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
      { pq: identity.mldsa, classical: identity.ed25519 },
    );

    try {
      return await ledger.appendEvent(event, resolver, { payload: payloadBytes });
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
    : new Error('appendProjectEvent: exhausted retries on contended chain head');
}
