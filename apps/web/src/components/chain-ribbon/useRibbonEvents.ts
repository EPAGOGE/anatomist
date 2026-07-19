// Event-stream hook for the chain ribbon — Phase 0 sub-phase E, E4.
//
// Fetches recent events from the chains we ambient-watch and normalizes
// them into RibbonEventMeta for visualizers. TanStack Query handles
// dedup, cache, and the polling cadence.

import { useQuery } from '@tanstack/react-query';
import { listChainEvents, type ChainEvent } from '../../api/endpoints.js';
import { useAuthStore } from '../../auth/store.js';
import { categorizeChain } from './iconography.js';
import type { RibbonEventMeta } from './types.js';

/** Platform-level chains we always watch. */
const SHARED_CHAINS = ['reasoning-capture', 'ai-interaction', 'system-operational'] as const;

/** How many events per chain we fetch in the ambient view. */
const AMBIENT_LIMIT = 8;

/**
 * Expanded mode fetches more events per chain. The expanded ribbon
 * lets users scroll a substantial slice of history; we cap to a
 * sensible bound to keep payload small.
 */
const EXPANDED_LIMIT = 40;

export interface UseRibbonEventsOptions {
  /** Pull-up state — when expanded, we fetch more events per chain. */
  readonly expanded: boolean;
}

export interface UseRibbonEventsResult {
  /** Most-recent-first across all watched chains. */
  readonly events: readonly RibbonEventMeta[];
  readonly isLoading: boolean;
  readonly isError: boolean;
}

/**
 * Hook used by the ribbon container. Returns a unified event list
 * across the user's canvas chain plus the shared platform chains.
 */
export function useRibbonEvents(opts: UseRibbonEventsOptions): UseRibbonEventsResult {
  const user = useAuthStore((s) => s.user);
  const userCanvasChain = user ? `architecture-composition:${user.id}` : null;
  const chains = userCanvasChain ? [userCanvasChain, ...SHARED_CHAINS] : [...SHARED_CHAINS];

  const limit = opts.expanded ? EXPANDED_LIMIT : AMBIENT_LIMIT;

  const q = useQuery({
    queryKey: ['chain-ribbon', { chains, limit }],
    queryFn: async () => {
      const results = await Promise.all(
        chains.map(async (chainId) => {
          try {
            const res = await listChainEvents(chainId, { limit });
            return res.events.map((e) => projectEvent(e));
          } catch {
            // A chain may not exist yet (e.g. the user's per-user
            // architecture chain before they save the first time).
            // Silent skip — the ribbon shouldn't be loud about an
            // expected emptiness.
            return [];
          }
        }),
      );
      const flat = results.flat();
      // Sort by marker descending. Marker is monotonic per chain but
      // not directly comparable across chains; for the ambient view
      // we accept slight cross-chain interleaving inaccuracy since
      // events on different chains are conceptually unordered with
      // respect to wall-clock anyway. A future schema bump that adds
      // `decision_date` lets us do this properly.
      flat.sort((a, b) => {
        if (a.marker !== b.marker) return Number(b.marker) - Number(a.marker);
        // Stable tiebreak via event hash so the order doesn't flicker.
        return a.eventHash.localeCompare(b.eventHash);
      });
      return flat;
    },
    refetchInterval: 15_000, // Quiet poll cadence.
    staleTime: 5_000,
  });

  return {
    events: q.data ?? [],
    isLoading: q.isLoading,
    isError: q.isError,
  };
}

function projectEvent(raw: ChainEvent): RibbonEventMeta {
  const { category, label } = categorizeChain(raw.chain_id);
  return {
    eventHash: raw.event_hash,
    chainId: raw.chain_id,
    eventType: raw.event_type,
    marker: raw.causal_sequence_marker,
    causalPredecessors: raw.causal_predecessors,
    sourceReliability: raw.source_reliability,
    payloadIntegrity: raw.payload_integrity,
    orderKey: raw.causal_sequence_marker,
    category,
    chainLabel: label,
    // Per ADR-0031: server-side ingest verifies signatures before
    // append; the API will not return tampered events. Phase 0
    // sub-phase F polish adds a client-side recheck mode where this
    // becomes a live verification (network → recompute hash →
    // compare); for now 'verified' is the honest baseline.
    verification: 'verified',
  };
}
