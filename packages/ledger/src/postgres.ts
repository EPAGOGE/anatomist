// Postgres-backed implementation of LedgerHandle.

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { type AttestedEvent, AttestedEventSchema, type EventType } from '@epagoge/shared';
import { blake3 } from '@epagoge/crypto';
import { computeEventHash, verifyAttestation } from './canonical.js';
import type { BlobStore } from './blob/index.js';
import {
  events,
  eventPredecessors,
  eventAbsenceEntries,
  chainHeads,
  type EventRow,
  type EventPredecessorRow,
  type EventAbsenceEntryRow,
} from './schema.js';
import {
  AppendError,
  type AppendOptions,
  type ChainHead,
  type LedgerHandle,
  type PublicKeyResolver,
  type VerificationFailure,
  type VerificationResult,
} from './types.js';

/**
 * Payload bytes ≤ this size are stored inline in the event row.
 * Payload bytes > this size are written through the BlobStore.
 * Threshold per the strategic index § "Content-addressed blob storage".
 */
export const INLINE_THRESHOLD_BYTES = 10_240;

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

type Schema = {
  events: typeof events;
  eventPredecessors: typeof eventPredecessors;
  eventAbsenceEntries: typeof eventAbsenceEntries;
  chainHeads: typeof chainHeads;
};

const SCHEMA: Schema = {
  events,
  eventPredecessors,
  eventAbsenceEntries,
  chainHeads,
};

/**
 * A transaction-scoped Drizzle handle. Exposed publicly as a generic type
 * (the @epagoge/ledger consumer can supply its own from drizzle.transaction
 * callback) so registration code can append events inside the same DB
 * transaction as the surrounding INSERTs.
 */
export type LedgerDb = NodePgDatabase<Schema>;

export interface PostgresLedgerOptions {
  /** Pre-existing pool to share with the rest of the app. If omitted, a pool is created from `databaseUrl`. */
  pool?: pg.Pool;
  /** Connection string; required if `pool` is not provided. */
  databaseUrl?: string;
  /**
   * Optional blob store for payload bytes that exceed INLINE_THRESHOLD_BYTES.
   * When omitted, large payloads cause appendEvent to throw — callers that
   * only deal with small payloads can leave this unset.
   */
  blobStore?: BlobStore;
}

export function createPostgresLedger(options: PostgresLedgerOptions): LedgerHandle & {
  close(): Promise<void>;
  withinTransaction<T>(fn: (txLedger: LedgerHandle, tx: LedgerDb) => Promise<T>): Promise<T>;
} {
  const pool =
    options.pool ??
    (options.databaseUrl
      ? new pg.Pool({ connectionString: options.databaseUrl })
      : (() => {
          throw new Error('createPostgresLedger requires pool or databaseUrl');
        })());
  const ownsPool = options.pool === undefined;
  const db = drizzle(pool, { schema: SCHEMA });
  return new PostgresLedger(db, pool, ownsPool, options.blobStore, false);
}

class PostgresLedger implements LedgerHandle {
  constructor(
    private readonly db: LedgerDb,
    private readonly pool: pg.Pool,
    private readonly ownsPool: boolean,
    private readonly blobStore: BlobStore | undefined,
    private readonly isInTx: boolean,
  ) {}

  /**
   * Run the given function inside a Postgres transaction. The function gets
   * a transaction-scoped ledger handle (whose appendEvent uses the same tx)
   * plus the raw Drizzle tx so the caller can do its own INSERTs in the
   * same tx. Either everything commits or everything rolls back.
   */
  async withinTransaction<T>(fn: (txLedger: LedgerHandle, tx: LedgerDb) => Promise<T>): Promise<T> {
    if (this.isInTx) {
      throw new Error('withinTransaction cannot be nested');
    }
    return this.db.transaction(async (tx) => {
      const txLedger = new PostgresLedger(tx, this.pool, false, this.blobStore, true);
      return fn(txLedger, tx);
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async appendEvent(
    event: AttestedEvent,
    resolveKeys: PublicKeyResolver,
    options: AppendOptions = {},
  ): Promise<string> {
    // Re-validate the event shape defensively.
    const parsed = AttestedEventSchema.parse(event);

    // (a) Hash check.
    const eventHash = computeEventHash(parsed);

    // (b) Signature check.
    const keys = await resolveKeys(parsed.source_id);
    if (!keys) {
      throw new AppendError(
        'public-key-not-found',
        eventHash,
        `no public keys registered for source_id=${parsed.source_id}`,
      );
    }
    const sigOk = await verifyAttestation(parsed, keys);
    if (!sigOk) {
      throw new AppendError('signature-invalid', eventHash);
    }

    // Payload handling. If the caller provided payload bytes, verify the
    // BLAKE3 hash matches event.payload_integrity (defense-in-depth — the
    // event's signed payload_integrity is the truth; we make sure the
    // bytes we're about to persist agree with it). Bytes ≤ threshold land
    // inline in the event row; bytes > threshold land in the blob store.
    let inlinePayload: Uint8Array | null = null;
    if (options.payload) {
      const recomputed = bytesToHex(blake3.hash(options.payload));
      if (recomputed !== parsed.payload_integrity) {
        throw new AppendError(
          'payload-hash-mismatch',
          eventHash,
          `payload hash ${recomputed} != event.payload_integrity ${parsed.payload_integrity}`,
        );
      }
      if (options.payload.length <= INLINE_THRESHOLD_BYTES) {
        inlinePayload = options.payload;
      } else {
        if (!this.blobStore) {
          throw new AppendError(
            'payload-hash-mismatch',
            eventHash,
            `payload size ${options.payload.length} exceeds inline threshold ${INLINE_THRESHOLD_BYTES} but no blob store is configured`,
          );
        }
        await this.blobStore.put(options.payload);
      }
    }

    // When the ledger is bound to an external transaction (isInTx), run the
    // validation+inserts directly on that tx. Otherwise wrap in a fresh tx.
    const runInTx = async (tx: LedgerDb): Promise<void> => {
      // (c) predecessors exist + (d) marker is strictly greater than each.
      for (const pred of parsed.causal_predecessors) {
        const predRow = await tx
          .select({
            marker: events.causalSequenceMarker,
          })
          .from(events)
          .where(eq(events.eventHash, pred))
          .limit(1);
        const predMarker = predRow[0]?.marker;
        if (predMarker === undefined) {
          throw new AppendError(
            'predecessor-missing',
            eventHash,
            `predecessor ${pred} not present`,
          );
        }
        if (parsed.causal_sequence_marker <= predMarker) {
          throw new AppendError(
            'predecessor-marker-violation',
            eventHash,
            `event marker ${parsed.causal_sequence_marker} not > predecessor ${pred} marker ${predMarker}`,
          );
        }
      }

      // (e) marker > current head for this (chain_id, source_id).
      //
      // FOR UPDATE on the chain_heads row serializes concurrent appenders.
      // Without it, READ COMMITTED lets two writers each read the same
      // pre-race head_marker, each pass this check, and each upsert the
      // chain_heads row — last-write-wins, with the loser's event row
      // inserted but orphaned (not reachable from head). With the row lock,
      // the second writer waits for the first to commit, then sees the new
      // marker and (correctly) throws sequence-marker-not-monotonic; the
      // caller retries with a fresh head. Genesis-event case: when the
      // chain_heads row doesn't exist yet, there's nothing to lock and a
      // race is still theoretically possible — but genesis events are
      // created at chain setup, not concurrently with normal traffic, so
      // that gap is acceptable until multi-source chains arrive.
      const head = await tx
        .select({
          headMarker: chainHeads.headSequenceMarker,
        })
        .from(chainHeads)
        .where(
          and(eq(chainHeads.chainId, parsed.chain_id), eq(chainHeads.sourceId, parsed.source_id)),
        )
        .limit(1)
        .for('update');
      const currentHeadMarker = head[0]?.headMarker;
      if (currentHeadMarker !== undefined && parsed.causal_sequence_marker <= currentHeadMarker) {
        throw new AppendError(
          'sequence-marker-not-monotonic',
          eventHash,
          `event marker ${parsed.causal_sequence_marker} not > head marker ${currentHeadMarker}`,
        );
      }

      // Insert the event row.
      await tx.insert(events).values({
        eventHash,
        chainId: parsed.chain_id,
        eventType: parsed.event_type as EventType,
        sourceId: parsed.source_id,
        causalSequenceMarker: parsed.causal_sequence_marker,
        sourceReliability: parsed.source_reliability,
        payloadIntegrity: parsed.payload_integrity,
        payloadInlineCbor: inlinePayload,
        signaturePq: parsed.attestation_signature.pq,
        signatureClassical: parsed.attestation_signature.classical,
        groundTruthCalibrationIndicator: parsed.ground_truth_calibration_indicator ?? null,
      });

      if (parsed.causal_predecessors.length > 0) {
        await tx.insert(eventPredecessors).values(
          parsed.causal_predecessors.map((predecessorHash, ordinal) => ({
            eventHash,
            ordinal,
            predecessorHash,
          })),
        );
      }

      if (parsed.absence_set_delta.length > 0) {
        await tx.insert(eventAbsenceEntries).values(
          parsed.absence_set_delta.map((entry, ordinal) => ({
            eventHash,
            ordinal,
            expectedHash: entry.expected_hash,
            windowStart: entry.window_start,
            windowEnd: entry.window_end,
          })),
        );
      }

      // Upsert the chain head.
      await tx
        .insert(chainHeads)
        .values({
          chainId: parsed.chain_id,
          sourceId: parsed.source_id,
          headHash: eventHash,
          headSequenceMarker: parsed.causal_sequence_marker,
          eventCount: 1n,
        })
        .onConflictDoUpdate({
          target: [chainHeads.chainId, chainHeads.sourceId],
          set: {
            headHash: eventHash,
            headSequenceMarker: parsed.causal_sequence_marker,
            eventCount: sql`${chainHeads.eventCount} + 1`,
            updatedAt: sql`now()`,
          },
        });
    };

    if (this.isInTx) {
      await runInTx(this.db);
    } else {
      await this.db.transaction(runInTx);
    }

    return eventHash;
  }

  async getEventPayload(eventHash: string): Promise<Uint8Array | null> {
    const rows = await this.db
      .select({
        inline: events.payloadInlineCbor,
        integrity: events.payloadIntegrity,
      })
      .from(events)
      .where(eq(events.eventHash, eventHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.inline) return new Uint8Array(row.inline);
    if (!this.blobStore) return null;
    return this.blobStore.get(row.integrity);
  }

  async getEvent(eventHash: string): Promise<AttestedEvent | null> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.eventHash, eventHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.assembleEvent(row);
  }

  async *walkPredecessors(
    eventHash: string,
    options: { maxDepth?: number } = {},
  ): AsyncIterable<AttestedEvent> {
    const maxDepth = options.maxDepth ?? Infinity;
    const visited = new Set<string>();
    type QueueItem = { hash: string; depth: number };
    const queue: QueueItem[] = [{ hash: eventHash, depth: 0 }];

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (visited.has(next.hash)) continue;
      visited.add(next.hash);
      if (next.depth > maxDepth) continue;

      const event = await this.getEvent(next.hash);
      if (!event) continue;
      yield event;
      for (const pred of event.causal_predecessors) {
        if (!visited.has(pred)) {
          queue.push({ hash: pred, depth: next.depth + 1 });
        }
      }
    }
  }

  async verifyChain(
    chainId: string,
    resolveKeys: PublicKeyResolver,
    options: { sourceId?: string } = {},
  ): Promise<VerificationResult> {
    const whereClause = options.sourceId
      ? and(eq(events.chainId, chainId), eq(events.sourceId, options.sourceId))
      : eq(events.chainId, chainId);

    const rows = await this.db
      .select()
      .from(events)
      .where(whereClause)
      .orderBy(events.causalSequenceMarker);

    const failures: VerificationFailure[] = [];
    let eventsVerified = 0;

    for (const row of rows) {
      const event = await this.assembleEvent(row);
      eventsVerified++;

      const recomputed = computeEventHash(event);
      if (recomputed !== row.eventHash) {
        failures.push({
          eventHash: row.eventHash,
          reason: 'hash-mismatch',
          detail: `recomputed ${recomputed} != stored ${row.eventHash}`,
        });
        continue;
      }

      const keys = await resolveKeys(event.source_id);
      if (!keys) {
        failures.push({
          eventHash: row.eventHash,
          reason: 'public-key-not-found',
          detail: `source_id=${event.source_id}`,
        });
        continue;
      }
      const sigOk = await verifyAttestation(event, keys);
      if (!sigOk) {
        failures.push({
          eventHash: row.eventHash,
          reason: 'signature-invalid',
        });
      }
    }

    return {
      ok: failures.length === 0,
      eventsVerified,
      failures,
    };
  }

  async getChainHead(chainId: string, sourceId: string): Promise<ChainHead | null> {
    const rows = await this.db
      .select()
      .from(chainHeads)
      .where(and(eq(chainHeads.chainId, chainId), eq(chainHeads.sourceId, sourceId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      chainId: row.chainId,
      sourceId: row.sourceId,
      headHash: row.headHash,
      headSequenceMarker: row.headSequenceMarker,
      eventCount: row.eventCount,
    };
  }

  async countChainEvents(chainId: string): Promise<bigint> {
    const rows = await this.db
      .select({ count: sql<string>`count(*)::text` })
      .from(events)
      .where(eq(events.chainId, chainId));
    return BigInt(rows[0]?.count ?? '0');
  }

  private async assembleEvent(row: EventRow): Promise<AttestedEvent> {
    const [predRows, absRows] = await Promise.all([
      this.db
        .select()
        .from(eventPredecessors)
        .where(eq(eventPredecessors.eventHash, row.eventHash))
        .orderBy(eventPredecessors.ordinal),
      this.db
        .select()
        .from(eventAbsenceEntries)
        .where(eq(eventAbsenceEntries.eventHash, row.eventHash))
        .orderBy(eventAbsenceEntries.ordinal),
    ]);

    const event: AttestedEvent = {
      version: 1,
      chain_id: row.chainId,
      event_type: row.eventType,
      source_id: row.sourceId,
      causal_predecessors: predRows.map((p: EventPredecessorRow) => p.predecessorHash),
      absence_set_delta: absRows.map((a: EventAbsenceEntryRow) => ({
        expected_hash: a.expectedHash,
        window_start: a.windowStart,
        window_end: a.windowEnd,
      })),
      source_reliability: row.sourceReliability,
      causal_sequence_marker: row.causalSequenceMarker,
      ground_truth_calibration_indicator: row.groundTruthCalibrationIndicator ?? undefined,
      attestation_signature: {
        pq: row.signaturePq,
        classical: row.signatureClassical,
      },
      payload_integrity: row.payloadIntegrity,
    };
    return event;
  }
}
