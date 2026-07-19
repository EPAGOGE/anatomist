// External-API emission classification — F-0 Task 105 rail-keeper.
//
// Per BUILD_RAILS.md rail-keeper #15: every external-API call site is
// tagged with its emission category per ADR-0039 at the call site, as
// a TypeScript const, not inferred from context.
//
// The classifications mirror ADR-0039's three categories applied to
// external-API call sites specifically:
//
//   'state-change-on-target' — the external call mutates remote state
//       (e.g., GitHub push, OAuth token creation). On the platform
//       chain, this emits a *-attempted or *-completed event tracking
//       the cross-system action's provenance.
//
//   'read-only' — the external call only reads (e.g., HF dataset
//       browsing, registry metadata). Does NOT emit anything on the
//       platform chain. The user's act of viewing produces no
//       provenance claim.
//
//   'failed-adversarial' — the external call is on an adversarial
//       boundary (e.g., webhook verification of a third-party signed
//       payload). Emits a *-failed variant on failure for forensic
//       trail.
//
//   'no-emit' — the external call is operational infrastructure
//       (e.g., health checks against an external monitor). Does not
//       emit. Declared explicitly to distinguish from 'read-only'
//       which is user-facing.
//
// The classification is REQUIRED at every chokepoint call site. The
// chokepoint type signature enforces this; calls without a tag fail
// at compile time.

export type EmissionClassification =
  | 'state-change-on-target'
  | 'read-only'
  | 'failed-adversarial'
  | 'no-emit';

/**
 * Per-call-site tag attached to every external-API invocation. The
 * `emission` field is the chokepoint's enforcement point for
 * rail-keeper #15.
 */
export interface ExternalCallSiteTag {
  /**
   * Stable identifier for this call site. Convention:
   * `<service>.<operation>` (e.g., `huggingface.datasets-search`,
   * `github.repo-push`). Used in observability and for the
   * future external-API emission classification table audit.
   */
  readonly site: string;
  /** Emission category per ADR-0039 applied to external-API calls. */
  readonly emission: EmissionClassification;
}
