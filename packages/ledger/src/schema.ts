// Drizzle table definitions for the provenance ledger.
// Owned by @epagoge/ledger; apps/api re-exports these as part of its
// migration-source schema bundle.
//
// All causal ordering is by `causal_sequence_marker` (bigint). `created_at`
// is display-only and never indexed for causal queries per ADR-0007.

import {
  pgTable,
  pgEnum,
  varchar,
  bigint,
  integer,
  customType,
  timestamp,
  text,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { EVENT_TYPES } from '@epagoge/shared/events';

// bytea column shared with other tables. Drizzle's customType keeps the JS
// side as Uint8Array; the pg driver round-trips Buffer.
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

export const eventTypeEnum = pgEnum('event_type', EVENT_TYPES);

// Events: one row per attested event, indexed by BLAKE3 hex hash of the
// canonical CBOR encoding.
export const events = pgTable(
  'events',
  {
    eventHash: varchar('event_hash', { length: 64 }).primaryKey(),
    chainId: varchar('chain_id', { length: 64 }).notNull(),
    eventType: eventTypeEnum('event_type').notNull(),
    sourceId: varchar('source_id', { length: 255 }).notNull(),
    causalSequenceMarker: bigint('causal_sequence_marker', { mode: 'bigint' }).notNull(),
    // source_reliability is the wire-format Q0.16 unsigned 16-bit value
    // (0-65535). Postgres has no unsigned 16-bit type, so we use `integer`
    // (4 bytes) and constrain at the Zod schema layer.
    sourceReliability: integer('source_reliability').notNull(),
    payloadIntegrity: varchar('payload_integrity', { length: 64 }).notNull(),
    // Inline payload for events whose canonical bytes fit under the
    // configured threshold (default INLINE_THRESHOLD_BYTES = 10 KiB,
    // see ledger postgres.ts). Larger payloads live in the blob store,
    // addressable by payload_integrity. Null means "not stored locally."
    payloadInlineCbor: bytea('payload_inline_cbor'),
    signaturePq: bytea('signature_pq').notNull(),
    signatureClassical: bytea('signature_classical').notNull(),
    groundTruthCalibrationIndicator: text('ground_truth_calibration_indicator'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byChainMarker: index('events_chain_marker_idx').on(table.chainId, table.causalSequenceMarker),
    bySourceMarker: index('events_source_marker_idx').on(
      table.chainId,
      table.sourceId,
      table.causalSequenceMarker,
    ),
  }),
);

// Predecessor references. Ordinal preserves the order of the original list,
// which matters for canonical encoding.
export const eventPredecessors = pgTable(
  'event_predecessors',
  {
    eventHash: varchar('event_hash', { length: 64 })
      .notNull()
      .references(() => events.eventHash, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    predecessorHash: varchar('predecessor_hash', { length: 64 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.eventHash, table.ordinal] }),
    byPredecessor: index('event_predecessors_predecessor_idx').on(table.predecessorHash),
  }),
);

// Absence-set entries. Ordinal preserves the order of the original list.
export const eventAbsenceEntries = pgTable(
  'event_absence_entries',
  {
    eventHash: varchar('event_hash', { length: 64 })
      .notNull()
      .references(() => events.eventHash, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    expectedHash: varchar('expected_hash', { length: 64 }).notNull(),
    windowStart: bigint('window_start', { mode: 'bigint' }).notNull(),
    windowEnd: bigint('window_end', { mode: 'bigint' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.eventHash, table.ordinal] }),
  }),
);

// Chain heads: current tip per (chain_id, source_id). Updated atomically with
// each append in the same transaction. Single-source-per-chain is the common
// case in Phase 0; the composite key supports multi-source in later phases.
export const chainHeads = pgTable(
  'chain_heads',
  {
    chainId: varchar('chain_id', { length: 64 }).notNull(),
    sourceId: varchar('source_id', { length: 255 }).notNull(),
    headHash: varchar('head_hash', { length: 64 }).notNull(),
    headSequenceMarker: bigint('head_sequence_marker', { mode: 'bigint' }).notNull(),
    eventCount: bigint('event_count', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.sourceId] }),
  }),
);

// Chain ownership. One row per chain. See ADR-0016.
//   owner_type:
//     'platform' — chain captures platform-level work; owner_entity_id='platform' sentinel.
//     'user'     — chain belongs to a user; owner_entity_id is users.id (UUID).
//     (Phase 2+) 'team', 'org' as multi-user collaboration arrives.
// Ownership is distinct from authorship: a single chain may have multiple
// source_ids writing to it (in future multi-source chains), but exactly one
// owner controls it.
export const chainOwners = pgTable('chain_owners', {
  chainId: varchar('chain_id', { length: 64 }).primaryKey(),
  ownerType: varchar('owner_type', { length: 32 }).notNull(),
  ownerEntityId: varchar('owner_entity_id', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type EventRow = typeof events.$inferSelect;
export type EventPredecessorRow = typeof eventPredecessors.$inferSelect;
export type EventAbsenceEntryRow = typeof eventAbsenceEntries.$inferSelect;
export type ChainHeadRow = typeof chainHeads.$inferSelect;
export type ChainOwnerRow = typeof chainOwners.$inferSelect;

export const OWNER_TYPES = ['platform', 'user'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/** Build the chain_id for a user-primary chain from the user's UUID. */
export function userPrimaryChainId(userUuid: string): string {
  return `user-primary:${userUuid}`;
}

/**
 * Build the chain_id for a user's architecture-composition chain.
 * Per-user from Phase 0 sub-phase E. Each canvas save lands a signed
 * event on this chain with the full GraphSpec as the CBOR payload.
 */
export function architectureCompositionChainId(userUuid: string): string {
  return `architecture-composition:${userUuid}`;
}
