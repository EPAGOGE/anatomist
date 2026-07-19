// Architecture-composition chain event payload schema.
//
// Phase 0 sub-phase E. Each canvas save lands a signed event on the
// per-user 'architecture-composition:<user_uuid>' chain. The payload
// IS the GraphSpec — the full structural definition that lets anyone
// with the chain replay the architecture deterministically.
//
// What's signed: nodes, edges, properties, name, description, version.
// What's NOT signed: UI-only state (node positions, zoom level, palette
// scroll). The chain captures STRUCTURE; the UI restores layout from a
// separate, unsigned UX preferences store.
//
// Version 1 is the baseline. Future schema migrations bump version and
// land a migrator that converts older payloads forward.

import { z } from 'zod';

/**
 * One node in the composed graph. Stable id, component type from the
 * registry, resolved property values.
 */
export const ArchitectureNodeSchema = z.object({
  id: z.string().min(1).max(64),
  componentId: z.string().min(1).max(128),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;

/**
 * One edge in the composed graph. Directed source → target by
 * (nodeId, portId) pairs.
 */
export const ArchitectureEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  source: z.object({
    nodeId: z.string().min(1),
    portId: z.string().min(1),
  }),
  target: z.object({
    nodeId: z.string().min(1),
    portId: z.string().min(1),
  }),
});
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;

/**
 * The full chain payload for an architecture-composition event.
 *
 * `kind` discriminates future event types on the same chain (e.g.
 * 'architecture-deleted', 'architecture-forked') without requiring a
 * schema migration on the existing 'architecture-saved' shape.
 *
 * `occurred_at` is metadata only (per ADR-0007). Causal ordering on
 * the chain comes from the predecessor reference + sequence marker.
 */
export const ArchitectureCompositionPayloadSchema = z.object({
  kind: z.literal('architecture-saved'),
  version: z.literal(1),
  /** Stable id for this architecture across saves (revisions share it). */
  architecture_id: z.string().uuid(),
  /**
   * Project containing this architecture. Optional per ADR-0036 so
   * architectures saved before the projects model (pre-F-0) remain
   * valid; the companion view surfaces them as legacy/orphan state.
   * New architectures from F-0 onward MUST carry a project_id.
   */
  project_id: z.string().uuid().optional(),
  /** Author-chosen name shown in lists. */
  name: z.string().min(1).max(128),
  /** Optional description. */
  description: z.string().max(2048).optional(),
  /** The composed graph. */
  nodes: z.array(ArchitectureNodeSchema),
  edges: z.array(ArchitectureEdgeSchema),
  /** Wall-clock timestamp for display (metadata only — see ADR-0007). */
  occurred_at: z.string().datetime(),
});
export type ArchitectureCompositionPayload = z.infer<typeof ArchitectureCompositionPayloadSchema>;
