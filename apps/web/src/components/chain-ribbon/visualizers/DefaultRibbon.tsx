// Default chain-ribbon visualizer — chip-and-connection pattern.
//
// Per ADR-0031 the default visualization is:
//   - Typed event chips arranged in a horizontal strip, most-recent
//     leftmost (since new events land at the head and the user expects
//     to see them).
//   - Phosphor icon per chain category — consistent visual vocabulary.
//   - Subtle verification dot (small ✓ pip in the top-right of each chip).
//   - Subtle connection cue between consecutive chips that share a
//     chain — a thin line on the chip edge so users sense the
//     predecessor relationship without visual clutter.
//   - Pull-up expansion into a fuller timeline grid.
//   - Hover → tooltip with event summary.
//   - Click → inspection drawer (handled by the container).
//
// Pitch Sprint Day 5 — cinematic restyle:
//   - Container uses design tokens (border-line, bg-panel/90, glass)
//   - Events slide in from the left with spring physics (AnimatePresence)
//   - The newest event briefly pulses .sign-pulse (iridescent flash)
//   - The verified-pip uses the iridescent gradient — the chain-signing
//     moment is the discipline-codified "this is verified" treatment
//     (per styles.css comment on --iridescent: "RESERVED for chain-
//     signing / verification moments"). This is the FIRST surface to
//     legitimately fire the discipline.
//   - Category colors (emerald/amber/violet/sky/rose) RETAINED — they
//     are a separate semantic vocabulary (chain-identity), not the
//     design system's neutral palette.

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CaretDoubleUp, CaretDoubleDown, ShieldCheck } from '@phosphor-icons/react';
import type { RibbonVisualizer, RibbonVisualizerProps, RibbonEventMeta } from '../types.js';
import { iconForChain, colorsForChain, eventTooltip } from '../iconography.js';

function DefaultRibbonComponent(props: RibbonVisualizerProps) {
  const { events, isLoading, expanded, onToggleExpanded, onInspect } = props;

  // Track the newest event hash so we can fire the iridescent sign-pulse
  // exactly once when a fresh event lands. Subsequent re-renders that
  // don't change the head don't re-trigger the pulse.
  const newestHash = events[0]?.eventHash ?? null;
  const lastSeenRef = useRef<string | null>(null);
  const [justSignedHash, setJustSignedHash] = useState<string | null>(null);

  useEffect(() => {
    if (newestHash && newestHash !== lastSeenRef.current) {
      // Skip the initial mount — only flash on subsequent new arrivals.
      if (lastSeenRef.current !== null) {
        setJustSignedHash(newestHash);
        const t = setTimeout(() => setJustSignedHash(null), 800);
        return () => clearTimeout(t);
      }
      lastSeenRef.current = newestHash;
    }
  }, [newestHash]);

  if (expanded) {
    return <ExpandedView {...props} />;
  }

  return (
    <div className="border-line bg-panel/85 border-t backdrop-blur-md">
      <div className="mx-auto flex max-w-full items-center gap-2 px-4 py-2.5">
        <span
          aria-label="Chain ribbon"
          className="text-dim flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]"
        >
          {' '}
          chain
        </span>

        <div className="flex flex-1 items-center gap-1.5 overflow-x-auto">
          {isLoading && <span className="text-dim text-[10px]">loading…</span>}
          {!isLoading && events.length === 0 && (
            <span className="text-dim text-[10px]">no recent events</span>
          )}
          <AnimatePresence initial={false} mode="popLayout">
            {events.map((ev, idx) => (
              <motion.div
                key={ev.eventHash}
                layout
                initial={{ opacity: 0, x: -20, scale: 0.9 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{
                  type: 'spring',
                  stiffness: 380,
                  damping: 26,
                  mass: 0.5,
                }}
              >
                <EventChip
                  event={ev}
                  previous={idx > 0 ? (events[idx - 1] ?? null) : null}
                  onClick={() => onInspect(ev)}
                  justSigned={ev.eventHash === justSignedHash}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <button
          type="button"
          onClick={onToggleExpanded}
          aria-label="Expand ribbon"
          title="Expand ribbon"
          className="text-dim hover:bg-panel-2 hover:text-text shrink-0 rounded p-1 transition"
        >
          <CaretDoubleUp size={14} weight="bold" />
        </button>
      </div>
    </div>
  );
}

function ExpandedView(props: RibbonVisualizerProps) {
  const { events, isLoading, onToggleExpanded, onInspect } = props;

  // Group events by chain category for clearer multi-row display in
  // the expanded view. The collapsed view shows everything in one
  // strip; the expanded view shows each chain as its own row.
  const byCategory = new Map<string, RibbonEventMeta[]>();
  for (const ev of events) {
    const arr = byCategory.get(ev.category) ?? [];
    arr.push(ev);
    byCategory.set(ev.category, arr);
  }

  // Order rows by a fixed semantic priority so layout doesn't flicker.
  const rowOrder = ['canvas', 'reasoning', 'ai', 'system', 'auth', 'user-primary', 'other'];
  const rows = rowOrder
    .map((cat) => ({ cat, evs: byCategory.get(cat) ?? [] }))
    .filter((r) => r.evs.length > 0);

  return (
    <motion.div
      initial={{ y: 40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 40, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 280, damping: 28 }}
      className="border-line bg-panel/90 border-t backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-full flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-dim flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]">
            {' '}
            Chain timeline — {events.length} recent events
          </span>
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-label="Collapse ribbon"
            title="Collapse ribbon"
            className="text-dim hover:bg-panel-2 hover:text-text ml-auto rounded p-1 transition"
          >
            <CaretDoubleDown size={14} weight="bold" />
          </button>
        </div>

        {isLoading && <div className="text-dim text-xs">loading…</div>}
        {!isLoading && rows.length === 0 && (
          <div className="text-dim text-xs">no recent events</div>
        )}
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-2">
          {rows.map(({ cat, evs }) => (
            <div key={cat} className="flex items-center gap-2">
              <RowLabel category={cat} />
              <div className="flex flex-1 items-center gap-1.5 overflow-x-auto">
                <AnimatePresence initial={false} mode="popLayout">
                  {evs.map((ev, idx) => (
                    <motion.div
                      key={ev.eventHash}
                      layout
                      initial={{ opacity: 0, x: -16, scale: 0.92 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.92 }}
                      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
                    >
                      <EventChip
                        event={ev}
                        previous={idx > 0 ? (evs[idx - 1] ?? null) : null}
                        onClick={() => onInspect(ev)}
                        justSigned={false}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function RowLabel({ category }: { category: string }) {
  // Width fixed so the rows align nicely.
  return (
    <span className="text-dim w-16 shrink-0 text-[10px] uppercase tracking-[0.18em]">
      {category}
    </span>
  );
}

function EventChip({
  event,
  previous,
  onClick,
  justSigned,
}: {
  event: RibbonEventMeta;
  previous: RibbonEventMeta | null;
  onClick: () => void;
  /** True when this event JUST landed — fires the iridescent sign-pulse. */
  justSigned: boolean;
}) {
  const colors = colorsForChain(event.category);
  const Icon = iconForChain(event.category);

  // Subtle connection cue: if the chip immediately to our right (the
  // visually "older" one in the most-recent-first layout) is on the
  // same chain AND we appear in their causal_predecessors, draw a
  // thin connector edge. This makes the chain backbone visible
  // without imposing a heavy line-drawing pass.
  const connectsToPrevious =
    previous !== null &&
    previous.chainId === event.chainId &&
    previous.causalPredecessors.includes(event.eventHash);

  return (
    <button
      type="button"
      onClick={onClick}
      title={eventTooltip(event)}
      className={[
        'group relative shrink-0 rounded-md border px-2 py-1 transition',
        colors.border,
        colors.background,
        'hover:scale-[1.03] hover:shadow-md hover:shadow-black/40',
        connectsToPrevious
          ? "before:bg-line before:absolute before:right-[-6px] before:top-1/2 before:h-px before:w-2 before:content-['']"
          : '',
        justSigned ? 'sign-pulse' : '',
      ].join(' ')}
    >
      <span className="flex items-center gap-1">
        <Icon size={12} weight="duotone" className={colors.foreground} />
        <span className={`text-[10px] font-medium ${colors.foreground}`}>{event.chainLabel}</span>
        <span className="text-dim/70 font-mono text-[9px]">#{event.marker}</span>
      </span>
      {event.verification === 'verified' && (
        <span
          className="bg-iridescent absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full shadow-sm"
          aria-label="cryptographically verified"
          title="cryptographically verified"
        >
          <ShieldCheck size={7} weight="fill" className="text-black/80" />
        </span>
      )}
    </button>
  );
}

export const DefaultRibbon: RibbonVisualizer = {
  id: 'default-chip-and-connection',
  displayName: 'Chips + connections',
  description:
    'Per-event chips colored by chain category with subtle connection cues for predecessor relationships. Pull up for an expanded multi-row timeline.',
  Component: DefaultRibbonComponent,
};
