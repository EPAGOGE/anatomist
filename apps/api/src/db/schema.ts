import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  integer,
  bigint,
  text,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';
import { NODE_ROLES } from '@epagoge/shared/types/user';
import { bytea } from '@epagoge/ledger/schema';

// Users table — identity registry for Phase 0 sub-phase A (local dev user)
// and sub-phase C onward (HTTP-registered users with email + argon2id
// password hash).
//
// Authentication columns:
//   email                - present for HTTP-registered users; null for the
//                          local_user (key-only auth in local dev).
//   email_lower          - lowercased copy for case-insensitive lookup; the
//                          UNIQUE index lives here so DIFFERENT casings of
//                          the same address cannot create duplicate accounts.
//   password_hash        - argon2id encoded string. Null for local_user.
//   attestation_secret_key_* - encrypted per ADR-0020 (env-var master key
//                          Phase 0; KMS path documented). Null for the
//                          local_user because its secret key lives on-disk
//                          in .local-keys/ and is never DB-persisted.
export const nodeRoleEnum = pgEnum('node_role', NODE_ROLES);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: varchar('source_id', { length: 255 }).notNull().unique(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    role: nodeRoleEnum('role').notNull(),
    attestationPublicKeyPq: bytea('attestation_public_key_pq').notNull(),
    attestationPublicKeyClassical: bytea('attestation_public_key_classical').notNull(),
    email: varchar('email', { length: 255 }),
    emailLower: varchar('email_lower', { length: 255 }),
    passwordHash: varchar('password_hash', { length: 512 }),
    attestationSecretKeyPqEnvelope: bytea('attestation_secret_key_pq_envelope'),
    attestationSecretKeyClassicalEnvelope: bytea('attestation_secret_key_classical_envelope'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    emailLowerUnique: uniqueIndex('users_email_lower_unique').on(table.emailLower),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

// API keys table. Each row represents one issued API key, identified by its
// id (UUID, used as the credential's public prefix) and the BLAKE3 hash of
// the secret part. The plaintext secret is shown to the user exactly once,
// at issue time. Lookup uses the prefix (extracted from the presented key)
// to find the row, then constant-time-compares the hashed secret.
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    prefix: varchar('prefix', { length: 24 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    byUser: index('api_keys_user_idx').on(table.userId),
    byPrefix: index('api_keys_prefix_idx').on(table.prefix),
  }),
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;

// AI interactions ledger. One row per Anthropic API call. Mirrors the
// ai-interaction chain event 1:1 — the chain is the cryptographic record;
// this table is the queryable analytics surface. cost_total_nanos sums
// the four component costs; redundant by design so the budget query
// (SELECT SUM(cost_total_nanos)) is a single index scan.
//
// All cost columns are bigint nanoUSD (1 USD = 1e9 nanoUSD). bigint
// addresses for billing arithmetic so we never round-trip through float.
export const aiInteractions = pgTable(
  'ai_interactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    sourceId: varchar('source_id', { length: 255 }).notNull(),
    purpose: varchar('purpose', { length: 64 }).notNull(),
    projectId: uuid('project_id'),
    feature: varchar('feature', { length: 128 }),

    model: varchar('model', { length: 64 }).notNull(),
    tier: varchar('tier', { length: 16 }).notNull(),
    cacheHitLocal: boolean('cache_hit_local').notNull().default(false),
    cacheHitPrompt: boolean('cache_hit_prompt').notNull().default(false),

    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),

    costInputNanos: bigint('cost_input_nanos', { mode: 'bigint' }).notNull(),
    costOutputNanos: bigint('cost_output_nanos', { mode: 'bigint' }).notNull(),
    costCacheReadNanos: bigint('cost_cache_read_nanos', { mode: 'bigint' }).notNull(),
    costCacheWriteNanos: bigint('cost_cache_write_nanos', { mode: 'bigint' }).notNull(),
    costTotalNanos: bigint('cost_total_nanos', { mode: 'bigint' }).notNull(),

    durationMs: integer('duration_ms').notNull(),
    finishReason: varchar('finish_reason', { length: 32 }),
    requestId: varchar('request_id', { length: 128 }),
    promptHash: varchar('prompt_hash', { length: 64 }).notNull(),
    responseHash: varchar('response_hash', { length: 64 }).notNull(),
    systemPromptId: varchar('system_prompt_id', { length: 128 }),
    contextSelectionJson: text('context_selection_json'),

    /** Links to the ai-interaction chain event hash. The chain row is the
     * cryptographic record; this column lets analytics queries find it. */
    chainEventHash: varchar('chain_event_hash', { length: 64 }),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byUser: index('ai_interactions_user_idx').on(table.userId, table.occurredAt),
    byPurpose: index('ai_interactions_purpose_idx').on(table.purpose, table.occurredAt),
    byProject: index('ai_interactions_project_idx').on(table.projectId, table.occurredAt),
    byModel: index('ai_interactions_model_idx').on(table.model, table.occurredAt),
  }),
);
export type AiInteractionRow = typeof aiInteractions.$inferSelect;
export type AiInteractionInsert = typeof aiInteractions.$inferInsert;

// Per-user monthly AI budget. One row per (user, period_start). Period is
// the first day of a calendar month UTC. Soft-warning percentage (default
// 80) drives an in-response header; hard cap is enforced by the
// orchestrator before any API call.
export const aiBudgets = pgTable(
  'ai_budgets',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    monthlyCapNanos: bigint('monthly_cap_nanos', { mode: 'bigint' }).notNull(),
    warnAtPct: integer('warn_at_pct').notNull().default(80),
    // Default expressed via SQL; drizzle-kit can't JSON-serialize a JS bigint literal.
    spentNanos: bigint('spent_nanos', { mode: 'bigint' })
      .notNull()
      .default(0 as unknown as bigint),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: uniqueIndex('ai_budgets_pk').on(table.userId, table.periodStart),
  }),
);
export type AiBudgetRow = typeof aiBudgets.$inferSelect;
export type AiBudgetInsert = typeof aiBudgets.$inferInsert;

// Deterministic-query response cache. cache_key = BLAKE3 of canonical
// (model || system_prompt || messages || effort) when temperature is
// effectively zero / not applicable. Distinct from Anthropic's own
// prompt cache — this is a platform-level memoization for repeated
// identical queries (e.g. classification, reasoning-capture summarization).
export const aiResponseCache = pgTable(
  'ai_response_cache',
  {
    cacheKey: varchar('cache_key', { length: 64 }).primaryKey(),
    model: varchar('model', { length: 64 }).notNull(),
    responseText: text('response_text').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
  },
  (table) => ({
    byExpiry: index('ai_response_cache_expiry_idx').on(table.expiresAt),
  }),
);
export type AiResponseCacheRow = typeof aiResponseCache.$inferSelect;
export type AiResponseCacheInsert = typeof aiResponseCache.$inferInsert;

// Chain pins. A user marks a specific event hash as a checkpoint on a
// given chain; later requests can ask "what's happened on this chain
// since this pin?" The pin is a soft anchor — it doesn't modify the
// chain itself, just records the user's bookmark.
//
// Unique on (user_id, chain_id, event_hash): a user can't pin the same
// hash twice on the same chain. They CAN pin the same hash across
// chains, and they CAN pin different events on the same chain.
export const chainPins = pgTable(
  'chain_pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chainId: varchar('chain_id', { length: 64 }).notNull(),
    eventHash: varchar('event_hash', { length: 64 }).notNull(),
    label: varchar('label', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pkUnique: uniqueIndex('chain_pins_user_chain_event_unique').on(
      table.userId,
      table.chainId,
      table.eventHash,
    ),
    byUser: index('chain_pins_user_idx').on(table.userId, table.chainId),
  }),
);
export type ChainPinRow = typeof chainPins.$inferSelect;
export type ChainPinInsert = typeof chainPins.$inferInsert;

// Projects table — F-0 Criterion 1, per ADR-0036.
//
// Projects are the unit of "starting work" for a user. The canvas,
// chat, and chain are scoped to a project once Criteria 5 + 7 land
// (reference resolver + project companion). For F-0 Criterion 1 the
// table exists and project creation emits a signed chain event on
// the user-primary chain.
//
// Ownership: per ADR-0036 the model aligns with chain_owners — one
// owner_user_id today; Phase 2's team collaboration extends to
// multi-member via a separate project_members table without changing
// this row's shape.
//
// lifecycle_position: user-settable freeform with conventional values
// (data / architecture / training / evaluation / deployment). F-0
// does not infer or automate transitions; the user moves the marker
// as their work progresses.
//
// creation_event_hash: bidirectional pointer to the project-created
// event on the user-primary chain. Per ADR-0017 every persisted row
// that has a chain event points back to it; this column closes that
// loop for projects.
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    description: varchar('description', { length: 2048 }),
    lifecyclePosition: varchar('lifecycle_position', { length: 32 })
      .notNull()
      .default('architecture'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    creationEventHash: varchar('creation_event_hash', { length: 64 }),
  },
  (table) => ({
    byOwner: index('projects_owner_idx').on(table.ownerUserId, table.createdAt),
    byOwnerLifecycle: index('projects_owner_lifecycle_idx').on(
      table.ownerUserId,
      table.lifecyclePosition,
    ),
  }),
);
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;

// project_dataset_references — F-0 Task 105 (HF dataset browsing, basic).
//
// Records a user's intent to use an external dataset in their project.
// Per the "basic" scope governor in the build doc: the platform does
// NOT download, host, or copy the dataset. The row is the operational
// mirror of the dataset-referenced chain event (with creation_event_hash
// pointing back per ADR-0017 bidirectional reference).
//
// Removal is soft (removed_at + removal_event_hash); the row is
// preserved so the project's history of references stays auditable.
// Re-referencing the same dataset after removal creates a new row
// with a new event — the chain shows the full referenced→removed→
// referenced-again arc.
export const projectDatasetReferences = pgTable(
  'project_dataset_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Source registry — 'huggingface' for now; future seam for other registries. */
    sourceRegistry: varchar('source_registry', { length: 32 }).notNull(),
    /** Registry's canonical dataset id. */
    datasetId: varchar('dataset_id', { length: 255 }).notNull(),
    datasetUrl: varchar('dataset_url', { length: 512 }).notNull(),
    datasetName: varchar('dataset_name', { length: 255 }).notNull(),
    license: varchar('license', { length: 128 }),
    taskType: varchar('task_type', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Null while reference is active; set when the user removes the reference. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    /** Hash of the dataset-referenced chain event that created this row. */
    creationEventHash: varchar('creation_event_hash', { length: 64 }).notNull(),
    /** Hash of the dataset-reference-removed chain event; null while active. */
    removalEventHash: varchar('removal_event_hash', { length: 64 }),
  },
  (table) => ({
    byProject: index('project_dataset_refs_project_idx').on(table.projectId, table.createdAt),
    byProjectActive: index('project_dataset_refs_project_active_idx').on(
      table.projectId,
      table.removedAt,
    ),
  }),
);
export type ProjectDatasetReferenceRow = typeof projectDatasetReferences.$inferSelect;
export type ProjectDatasetReferenceInsert = typeof projectDatasetReferences.$inferInsert;

// project_code_exports — F-0 Task 106 (basic GitHub code export).
//
// Records every code-export action with full provenance: which
// architecture was exported (FK to architecture-saved chain event
// hash), where it went (GitHub repo + branch + path), what commit
// resulted (SHA), and the content hash (BLAKE3) for tamper-evidence.
//
// Unlike project_dataset_references (which uses soft-removal +
// idempotency), code-exports rows are immutable and non-idempotent:
// every export is recorded as a new row + new chain event. The chain
// shows the full export history; the DB mirrors it for queries.
export const projectCodeExports = pgTable(
  'project_code_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Architecture-saved event hash being exported (cross-chain reference). */
    architectureId: uuid('architecture_id').notNull(),
    architectureEventHash: varchar('architecture_event_hash', { length: 64 }).notNull(),
    /** Destination registry — 'github' for now; future seam for gitlab/bitbucket. */
    destinationKind: varchar('destination_kind', { length: 32 }).notNull(),
    /** owner/repo on the destination registry. */
    destinationRepo: varchar('destination_repo', { length: 255 }).notNull(),
    destinationBranch: varchar('destination_branch', { length: 255 }).notNull(),
    destinationPath: varchar('destination_path', { length: 512 }).notNull(),
    /** External commit SHA from the destination registry. */
    commitSha: varchar('commit_sha', { length: 40 }).notNull(),
    /** BLAKE3 hash of the exported code content. */
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Chain event hash of the code-exported event (cycle-closing reference). */
    chainEventHash: varchar('chain_event_hash', { length: 64 }).notNull(),
  },
  (table) => ({
    byProject: index('project_code_exports_project_idx').on(table.projectId, table.createdAt),
    byArchitecture: index('project_code_exports_architecture_idx').on(
      table.architectureId,
      table.createdAt,
    ),
  }),
);
export type ProjectCodeExportRow = typeof projectCodeExports.$inferSelect;
export type ProjectCodeExportInsert = typeof projectCodeExports.$inferInsert;

// chat_sessions — persistent Chat page conversations, per user.
//
// Pure UI state, NOT a ledger chain: saved so a user's chats survive reloads
// and logins and (when the platform is hosted) sync across devices. The id is
// client-generated so the web app can upsert a session it created offline.
// `entries` mirrors the web ConversationEntry[] shape (role/content + optional
// response metadata) as jsonb; the route validates its shape on write.
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }).notNull().default('New chat'),
    entries: jsonb('entries').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byOwner: index('chat_sessions_owner_idx').on(table.ownerUserId, table.updatedAt),
  }),
);
export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type ChatSessionInsert = typeof chatSessions.$inferInsert;

// Re-export ledger tables so drizzle-kit picks them up from this single
// schema-source-of-truth. The actual definitions live in @epagoge/ledger.
export {
  events,
  eventPredecessors,
  eventAbsenceEntries,
  chainHeads,
  chainOwners,
  eventTypeEnum,
} from '@epagoge/ledger/schema';
