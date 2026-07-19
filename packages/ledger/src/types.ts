import type { AttestedEvent } from '@epagoge/shared';
import type { AttestationPublicKeys } from './canonical.js';

export interface ChainHead {
  chainId: string;
  sourceId: string;
  headHash: string;
  headSequenceMarker: bigint;
  eventCount: bigint;
}

export type PublicKeyResolver = (sourceId: string) => Promise<AttestationPublicKeys | null>;

export type AppendFailureReason =
  | 'signature-invalid'
  | 'predecessor-missing'
  | 'predecessor-marker-violation'
  | 'sequence-marker-not-monotonic'
  | 'public-key-not-found'
  | 'hash-mismatch'
  | 'payload-hash-mismatch';

export class AppendError extends Error {
  readonly reason: AppendFailureReason;
  readonly eventHash: string;
  readonly detail?: string;

  constructor(reason: AppendFailureReason, eventHash: string, detail?: string) {
    super(`AppendError(${reason}) for event ${eventHash}${detail ? ': ' + detail : ''}`);
    this.name = 'AppendError';
    this.reason = reason;
    this.eventHash = eventHash;
    this.detail = detail;
  }
}

export interface VerificationFailure {
  eventHash: string;
  reason: AppendFailureReason;
  detail?: string;
}

export interface VerificationResult {
  ok: boolean;
  eventsVerified: number;
  failures: VerificationFailure[];
}

export interface AppendOptions {
  /**
   * Canonical payload bytes to persist alongside the event. The ledger
   * verifies BLAKE3(payload) === event.payload_integrity before storing.
   * Bytes shorter than the inline threshold are written into the event row;
   * larger bytes are written through the BlobStore.
   *
   * When omitted, only the event metadata is stored; the caller assumes
   * responsibility for the payload bytes (either holds them out-of-band
   * or never needs to retrieve them).
   */
  readonly payload?: Uint8Array;
}

export interface LedgerHandle {
  /**
   * Append a fully-signed AttestedEvent. Transactional. Validates:
   *   (a) recomputed event hash matches expected,
   *   (b) both signatures verify with public keys resolved via the resolver,
   *   (c) all causal_predecessors exist in the ledger,
   *   (d) causal_sequence_marker is strictly greater than every predecessor's marker,
   *   (e) causal_sequence_marker is strictly greater than the chain head's marker
   *       for the same (chain_id, source_id), if a head exists.
   *
   * Returns the canonical event hash on success. Throws AppendError on any
   * validation failure (no partial writes).
   */
  appendEvent(
    event: AttestedEvent,
    resolveKeys: PublicKeyResolver,
    options?: AppendOptions,
  ): Promise<string>;

  /** Look up an event by its canonical hash. Returns null if not present. */
  getEvent(eventHash: string): Promise<AttestedEvent | null>;

  /**
   * Look up the canonical payload bytes for an event. Returns the inline
   * bytes when small, fetches from the blob store when large, returns null
   * if no payload was ever persisted for this event.
   */
  getEventPayload(eventHash: string): Promise<Uint8Array | null>;

  /**
   * Walk causal predecessors starting from the given event. Yields events in
   * breadth-first order. Each event is yielded at most once even if reachable
   * through multiple predecessor paths.
   */
  walkPredecessors(
    eventHash: string,
    options?: { maxDepth?: number },
  ): AsyncIterable<AttestedEvent>;

  /**
   * Re-run signature verification for every event on the given chain (and
   * optionally restricted to a single source). Walks in causal_sequence_marker
   * order and reports each failure individually.
   */
  verifyChain(
    chainId: string,
    resolveKeys: PublicKeyResolver,
    options?: { sourceId?: string },
  ): Promise<VerificationResult>;

  /** Get the current head for a chain/source, or null when the chain is empty. */
  getChainHead(chainId: string, sourceId: string): Promise<ChainHead | null>;

  /** Count of events in a chain (across all sources). */
  countChainEvents(chainId: string): Promise<bigint>;

  /** Release any owned resources (e.g. an internally-created pg.Pool). */
  close(): Promise<void>;
}
