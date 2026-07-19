// Multi-chain identity. See docs/adrs/0011-chain-taxonomy.md.
//
// The platform supports multiple distinct chains operating in parallel from
// Phase 0. Each event carries a chain_id designating which chain it belongs to.
// Cross-chain provenance is expressed through causal_predecessors that
// reference events in other chains by hash.

import { z } from 'zod';

// Well-known chain identifiers active from Phase 0. Additional chains may be
// added by future ADRs.
export const WELL_KNOWN_CHAINS = [
  'user-primary',
  'reasoning-capture',
  'ai-interaction',
  'system-operational',
  'validation-pattern',
  'auth-events',
  'architecture-composition',
] as const;

// 'ai-interaction' is now active from Phase 0 sub-phase D. Every AI API
// call produces a signed event on this chain with model, tokens, cost,
// purpose, project, and context-selection metadata (see ADR-0025).
//
// 'architecture-composition' is active from Phase 0 sub-phase E. Each
// canvas save produces a signed event with the full GraphSpec as the
// CBOR payload. Per-user chain: 'architecture-composition:<user_uuid>'.
// The bare 'architecture-composition' identifier is reserved for the
// shared catalog of community-contributed architectures (Phase 1+).

export type WellKnownChain = (typeof WELL_KNOWN_CHAINS)[number];

// The schema accepts any non-empty string (so future chain identifiers don't
// require a schema migration) but exports the canonical list for code that
// wants the strict enum at compile time.
export const ChainIdSchema = z.string().min(1).max(64);
export type ChainId = z.infer<typeof ChainIdSchema>;

// Event type taxonomy. The four categories distinguish origin and trust
// characteristics of the event. Every event carries one.
export const EVENT_TYPES = [
  'user-generated',
  'synthetic-derived',
  'system-operational',
  'validation-attestation',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EventTypeSchema = z.enum(EVENT_TYPES);
