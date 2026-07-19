// Chain-ribbon container — Phase 0 sub-phase E, E4.
//
// The dispatcher: reads user preference for which visualizer to use,
// fetches the event stream, manages expanded state + inspector drawer,
// and renders the chosen visualizer.
//
// Per ADR-0031 the architecture is swappable but Phase 0 sub-phase E
// ships only the default. The preference plumbing is here so adding
// a new visualizer is a single registry entry + a user-preference
// option, no container changes required.

import { useMemo, useState } from 'react';
import { useRibbonEvents } from './useRibbonEvents.js';
import { EventInspector } from './EventInspector.js';
import { DefaultRibbon } from './visualizers/DefaultRibbon.js';
import type { RibbonEventMeta, RibbonVisualizer } from './types.js';

/**
 * Registry of available visualizers. New visualizers register here.
 * Tests can mock or extend this in a future tranche; for E4 the
 * registry is module-scoped and immutable.
 */
const VISUALIZERS: readonly RibbonVisualizer[] = [DefaultRibbon] as const;

const DEFAULT_VISUALIZER_ID = DefaultRibbon.id;

export function RibbonContainer() {
  const [expanded, setExpanded] = useState(false);
  const [inspecting, setInspecting] = useState<RibbonEventMeta | null>(null);

  const events = useRibbonEvents({ expanded });

  // For E4 the preference is hardcoded. The lookup-by-id pattern
  // is in place so Phase 0 sub-phase F polish (user-preference UI)
  // is a small change rather than a refactor.
  const activeId = DEFAULT_VISUALIZER_ID;
  const visualizer = useMemo(
    () => VISUALIZERS.find((v) => v.id === activeId) ?? DefaultRibbon,
    [activeId],
  );

  const Visualizer = visualizer.Component;

  return (
    <>
      <Visualizer
        events={events.events}
        isLoading={events.isLoading}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((e) => !e)}
        onInspect={setInspecting}
      />
      {inspecting && <EventInspector event={inspecting} onClose={() => setInspecting(null)} />}
    </>
  );
}

/**
 * Test/debug helper — list the registered visualizers. Exposed so
 * unit tests can verify the registry composition without importing
 * VISUALIZERS directly (which would force the module-internal name
 * into the public surface).
 */
export function listRibbonVisualizers(): readonly RibbonVisualizer[] {
  return VISUALIZERS;
}
