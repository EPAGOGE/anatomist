// Project lifecycle chain event payloads — F-0 Criterion 1 (ADR-0036).
//
// Projects are the unit of "starting work" for a user. Project
// lifecycle events (creation, lifecycle_position changes) live on
// the user-primary chain. The per-user architecture-composition
// chain stays unchanged; its payloads gain an optional `project_id`
// field so architectures can be scoped to a project without
// fragmenting the chain inventory into per-project chains.
//
// Rationale (per ADR-0036): a per-project chain would proliferate
// chain identities (one per project per user); a single chain with
// payload-level scoping keeps the chain inventory bounded while
// supporting per-project queries via payload filtering. The
// architecture-composition chain stays per-user because its events
// pre-date the projects model and the project_id is optional —
// pre-F-0 saves remain valid (project_id absent = "orphan" project
// state, surfaced in the companion view as legacy work).

import { z } from 'zod';

/**
 * Conventional lifecycle positions. The field is user-settable and
 * the validator constrains it to this set so the companion's
 * lifecycle UI has a closed vocabulary to render. New positions
 * land as a schema bump if/when the catalog evolves.
 */
export const LIFECYCLE_POSITIONS = [
  'data',
  'architecture',
  'training',
  'evaluation',
  'deployment',
] as const;

export type LifecyclePosition = (typeof LIFECYCLE_POSITIONS)[number];
export const LifecyclePositionSchema = z.enum(LIFECYCLE_POSITIONS);

/**
 * Project-created event on the user-primary chain. The first
 * deliberate user action after registration — they name a project
 * and the platform records it as signed history.
 *
 * `project_id` is the same UUID stored in the projects table; the
 * row's `creation_event_hash` points back to the chain event that
 * produced it (bidirectional ADR-0017 reference).
 */
export const ProjectCreatedPayloadSchema = z.object({
  kind: z.literal('project-created'),
  version: z.literal(1),
  project_id: z.string().uuid(),
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  lifecycle_position: LifecyclePositionSchema,
  /** Wall-clock for display only (metadata; ADR-0007). */
  occurred_at: z.string().datetime(),
});
export type ProjectCreatedPayload = z.infer<typeof ProjectCreatedPayloadSchema>;

/**
 * Project lifecycle moved. Records the transition (previous → next)
 * so the companion can render the project's history without
 * inferring from snapshots.
 */
export const ProjectLifecycleUpdatedPayloadSchema = z.object({
  kind: z.literal('project-lifecycle-updated'),
  version: z.literal(1),
  project_id: z.string().uuid(),
  previous_position: LifecyclePositionSchema,
  new_position: LifecyclePositionSchema,
  occurred_at: z.string().datetime(),
});
export type ProjectLifecycleUpdatedPayload = z.infer<typeof ProjectLifecycleUpdatedPayloadSchema>;

/**
 * Dataset-referenced event on the user-primary chain. The user has
 * recorded an intent to use a specific external dataset (Hugging Face
 * Hub for now) in their project. Per F-0 Task 105 "basic" scope: the
 * platform does NOT download, host, or copy the dataset — it records
 * the reference (decision + provenance). The user's verifiable history
 * now includes "intends to use dataset X" as a signed event.
 *
 * Category 1 emission per ADR-0039 (state-changing user action;
 * emits on user-primary chain alongside project-created and
 * project-lifecycle-updated).
 */
export const DatasetReferencedPayloadSchema = z.object({
  kind: z.literal('dataset-referenced'),
  version: z.literal(1),
  project_id: z.string().uuid(),
  /** Local UUID for the project_dataset_references row this event creates. */
  reference_id: z.string().uuid(),
  /** Source registry. 'huggingface' for now; future seam for other registries. */
  source_registry: z.literal('huggingface'),
  /** Registry's canonical dataset id (e.g., "imdb", "squad", "wikitext"). */
  dataset_id: z.string().min(1).max(255),
  /** Canonical URL to the dataset's registry page. */
  dataset_url: z.string().url(),
  /** Display name from registry metadata. */
  dataset_name: z.string().min(1).max(255),
  /** SPDX or registry-reported license identifier. */
  license: z.string().max(128).optional(),
  /** Registry-reported task type (e.g., "text-classification"). */
  task_type: z.string().max(128).optional(),
  /** Wall-clock for display only (metadata; ADR-0007). */
  occurred_at: z.string().datetime(),
});
export type DatasetReferencedPayload = z.infer<typeof DatasetReferencedPayloadSchema>;

/**
 * Dataset-reference-removed event on the user-primary chain. The user
 * has explicitly withdrawn the dataset reference. Per ADR-0039 D.11
 * (undo-emits-compensating-event), removal does NOT rewrite history —
 * it emits a new event referencing the original dataset-referenced
 * event via `original_event_hash`. The chain stays append-only; the
 * record of "user intended X, then withdrew" is preserved.
 *
 * Category 1 emission. Distinct from chain pins (named exception in
 * ADR-0039 that doesn't emit on either create or delete) because a
 * dataset reference IS a stated provenance claim — its withdrawal is
 * itself a stated claim worth recording.
 */
export const DatasetReferenceRemovedPayloadSchema = z.object({
  kind: z.literal('dataset-reference-removed'),
  version: z.literal(1),
  project_id: z.string().uuid(),
  /** Same UUID as the dataset-referenced event being undone. */
  reference_id: z.string().uuid(),
  /** BLAKE3 hash of the original dataset-referenced chain event. */
  original_event_hash: z.string().regex(/^[0-9a-f]{64}$/),
  occurred_at: z.string().datetime(),
});
export type DatasetReferenceRemovedPayload = z.infer<typeof DatasetReferenceRemovedPayloadSchema>;

/**
 * Code-exported event on the user-primary chain. F-0 Task 106 (basic
 * GitHub code export). The user has pushed generated code from one of
 * their attested architectures to an external destination (GitHub for
 * now; future seam for other destinations).
 *
 * The payload creates the platform's distinctive verifiable provenance
 * claim: "this attested architecture (chain marker N, event hash H)
 * became this code (BLAKE3 content hash X) at this external commit
 * (SHA Y) in this repo at this path." Future verifiers can confirm
 * the link is intact by re-generating code from the attested
 * architecture and comparing content hashes, then comparing against
 * the live commit at the recorded SHA.
 *
 * Category 1 emission per ADR-0039 (state-changing action that produces
 * a cross-system effect; emits on user-primary chain alongside other
 * project events). Per ADR-0039 Part B export forward seam: export-to-
 * external-destination DOES emit a chain event for provenance — this
 * pass IS the realization of that decision.
 *
 * Re-export is NOT idempotent (deliberate departure from Task 105's
 * dataset-referenced idempotency): each export is a discrete provenance
 * claim; the chain records every push, not the most-recent one. This
 * matches the canvas-save pattern (every save is a new event) more
 * than the dataset-reference pattern (idempotent on same active claim).
 */
export const CodeExportedPayloadSchema = z.object({
  kind: z.literal('code-exported'),
  version: z.literal(1),
  project_id: z.string().uuid(),
  /** Local UUID for the project_code_exports row this event creates. */
  export_id: z.string().uuid(),
  /** Architecture identifier (matches architecture-saved payload's architecture_id). */
  architecture_id: z.string().uuid(),
  /** BLAKE3 chain-event hash of the architecture-saved event being exported. */
  architecture_event_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Destination registry kind. 'github' for now; future seam (gitlab, bitbucket). */
  destination_kind: z.literal('github'),
  /** owner/repo identifier on the destination. */
  destination_repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/)
    .max(255),
  /** Branch the commit went to. */
  destination_branch: z.string().min(1).max(255),
  /** File path within the repo. */
  destination_path: z.string().min(1).max(512),
  /** Resulting external commit SHA (GitHub returns 40-char hex). */
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  /** BLAKE3 content hash of the exported code; lets future verifiers detect tamper. */
  code_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Wall-clock for display only (metadata; ADR-0007). */
  occurred_at: z.string().datetime(),
});
export type CodeExportedPayload = z.infer<typeof CodeExportedPayloadSchema>;

/**
 * Discriminated union over all project lifecycle event payloads.
 * Future event kinds (renamed, archived) extend the union without
 * breaking existing consumers.
 */
export const ProjectLifecycleEventPayloadSchema = z.discriminatedUnion('kind', [
  ProjectCreatedPayloadSchema,
  ProjectLifecycleUpdatedPayloadSchema,
  DatasetReferencedPayloadSchema,
  DatasetReferenceRemovedPayloadSchema,
  CodeExportedPayloadSchema,
]);
export type ProjectLifecycleEventPayload = z.infer<typeof ProjectLifecycleEventPayloadSchema>;
