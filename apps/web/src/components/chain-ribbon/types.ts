// Chain-ribbon visualizer architecture — Phase 0 sub-phase E, tranche E4.
//
// The chain ribbon is the visible manifestation of EPAGOGE's cryptographic
// substrate. Other platforms have visual node editors and code generation;
// only EPAGOGE produces cryptographically attested architecture history
// with verifiable provenance. The ribbon is what makes that substrate
// ambient — present without being preachy.
//
// Per ADR-0031: the visualization is SWAPPABLE by design. Different
// users have different visual processing preferences; the platform will
// evolve; multi-domain expansion may want domain-specific visualizers;
// accessibility needs vary. Locking into one visualization forecloses
// iteration that user feedback may demand. The plugin interface here
// lets new visualizers ship without rewriting the chain layer.
//
// The DEFAULT visualizer (./visualizers/DefaultRibbon.tsx) ships with
// sub-phase E and serves the majority case. Future tranches and phases
// can add alternatives.

import type { ComponentType } from 'react';

/**
 * Normalized event the visualizer consumes. This is a thin projection
 * over ChainEvent (api/endpoints.ts) augmented with derived display
 * metadata. Visualizers should not need to fetch additional data to
 * render the ambient view — they can dispatch fetches when the user
 * clicks for inspection.
 */
export interface RibbonEvent {
  /** SHA-256 hex digest of the attested event. Stable, unique. */
  readonly eventHash: string;

  /** The chain this event lives on (e.g. 'reasoning-capture'). */
  readonly chainId: string;

  /**
   * Event-type discriminator from the schema:
   * user-generated | synthetic-derived | system-operational | validation-attestation.
   */
  readonly eventType: string;

  /** Monotonic sequence marker within the chain. */
  readonly marker: string;

  /** Hashes of upstream events. [0] is chain backbone; [1+] are cross-chain refs. */
  readonly causalPredecessors: readonly string[];

  /** Cryptographic source-reliability score (Q16.16, integer wire form). */
  readonly sourceReliability: number;

  /** Hex digest of the payload (used as the verification anchor). */
  readonly payloadIntegrity: string;

  /**
   * Ordering timestamp for the visualizer. Currently derived from
   * marker (monotonic per chain) since we don't expose wall-clock to
   * the ribbon. May become a true `decision_date` field in a future
   * schema bump.
   */
  readonly orderKey: string;
}

/**
 * The "category" a chain belongs to from the user's perspective. The
 * visualizer uses this to pick row placement, color, and default icon.
 *
 * Drawn from the chain-id taxonomy in packages/shared/src/events/chain-id.ts
 * but normalized for display.
 */
export type RibbonChainCategory =
  | 'canvas' // architecture-composition:<user_uuid>
  | 'reasoning' // reasoning-capture
  | 'ai' // ai-interaction
  | 'system' // system-operational
  | 'auth' // auth-events
  | 'user-primary' // user-primary:<user_uuid>
  | 'other';

/**
 * Visualization metadata attached to each event. The container computes
 * this once and passes it down so visualizers don't each re-derive it.
 */
export interface RibbonEventMeta extends RibbonEvent {
  /** Normalized chain category for layout + theming. */
  readonly category: RibbonChainCategory;

  /** Short label for the chip (e.g. "canvas", "reasoning"). */
  readonly chainLabel: string;

  /**
   * Cryptographic-verification state surfaced to the visualizer. For
   * Phase 0 sub-phase E this is `'verified'` for everything the API
   * returned (the server-side ingest verifies before append, so if it's
   * on the chain it's verified). The schema is open for `'unverified'`
   * and `'tampered'` once client-side recheck UX lands in F polish.
   */
  readonly verification: 'verified' | 'unverified' | 'tampered';
}

/**
 * The contract every chain-ribbon visualizer satisfies. The container
 * mounts ONE of these at a time based on user preference (default:
 * 'default-chip-and-connection'). All visualizers receive the same
 * normalized event stream and the same interaction callbacks.
 */
export interface RibbonVisualizer {
  /** Stable identifier — used in the user preference setting. */
  readonly id: string;

  /** Human-readable name for the preference UI. */
  readonly displayName: string;

  /** One-line description for tooltips / preference UI. */
  readonly description: string;

  /** The actual React component the container renders. */
  readonly Component: ComponentType<RibbonVisualizerProps>;
}

/** Props every visualizer receives. */
export interface RibbonVisualizerProps {
  /** Most-recent-first list of events across all watched chains. */
  readonly events: readonly RibbonEventMeta[];

  /** Loading state — the visualizer may render a skeleton. */
  readonly isLoading: boolean;

  /** Whether the user has pulled the ribbon up to its expanded form. */
  readonly expanded: boolean;

  /** Toggle the expanded state. */
  readonly onToggleExpanded: () => void;

  /** Open the inspection drawer for a specific event. */
  readonly onInspect: (event: RibbonEventMeta) => void;
}
