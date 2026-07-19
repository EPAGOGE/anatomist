// Event inspection drawer — Phase 0 sub-phase E, E4.
//
// Opens when a ribbon chip is clicked. Shows the full event detail
// (chain, type, marker, hash, signatures, predecessors). Click-through
// links to the chain detail page for deeper exploration.
//
// The drawer is deliberately small — it surfaces the cryptographic
// substrate without overwhelming. Power users go to the chain detail
// page for full event inspection; the drawer is the ambient bridge.

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowSquareOut, X, ShieldCheck } from '@phosphor-icons/react';
import { getEvent, type EventDetailResponse } from '../../api/endpoints.js';
import type { RibbonEventMeta } from './types.js';
import { iconForChain, colorsForChain } from './iconography.js';

export function EventInspector({
  event,
  onClose,
}: {
  event: RibbonEventMeta | null;
  onClose: () => void;
}) {
  // Fetch full event detail lazily when the drawer opens.
  const detail = useQuery({
    queryKey: ['ribbon-event-detail', event?.eventHash],
    queryFn: async () => (event ? getEvent(event.eventHash) : null),
    enabled: event !== null,
    staleTime: 60_000,
  });

  if (!event) return null;

  const colors = colorsForChain(event.category);
  const Icon = iconForChain(event.category);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Event details"
      className="fixed inset-x-0 bottom-12 z-40 mx-auto w-full max-w-xl rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <div className={`rounded p-2 ${colors.background} ${colors.border} border`}>
          <Icon size={20} weight="duotone" className={colors.foreground} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${colors.foreground}`}>{event.chainLabel}</span>
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">
              {event.eventType}
            </span>
            <span className="ml-auto font-mono text-[10px] text-neutral-500">#{event.marker}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-neutral-400" title={event.eventHash}>
            {event.eventHash.slice(0, 32)}…
          </div>
          {event.verification === 'verified' && (
            <div className="mt-2 inline-flex items-center gap-1 text-[10px] text-emerald-400">
              <ShieldCheck size={12} weight="duotone" />
              <span>signature verified by server ingest</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200"
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 text-[11px] sm:grid-cols-2">
        <Field label="Chain">
          <span className="font-mono text-neutral-300">{event.chainId}</span>
        </Field>
        <Field label="Source reliability">
          <span className="font-mono text-neutral-300">
            {formatReliability(event.sourceReliability)}
          </span>
        </Field>
        <Field label="Payload hash">
          <span className="font-mono text-neutral-400" title={event.payloadIntegrity}>
            {event.payloadIntegrity.slice(0, 16)}…
          </span>
        </Field>
        <Field label="Predecessors">
          {event.causalPredecessors.length === 0 ? (
            <span className="text-neutral-500">(genesis)</span>
          ) : (
            <div className="space-y-0.5">
              <span className="font-mono text-neutral-400" title={event.causalPredecessors[0]}>
                backbone: {event.causalPredecessors[0]!.slice(0, 12)}…
              </span>
              {event.causalPredecessors.slice(1).map((p) => (
                <div key={p} className="font-mono text-neutral-500" title={p}>
                  cross: {p.slice(0, 12)}…
                </div>
              ))}
            </div>
          )}
        </Field>
      </div>

      {detail.data && <PayloadSizeRow detail={detail.data} />}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Link
          to={`/chains/${encodeURIComponent(event.chainId)}`}
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100"
        >
          Open chain
          <ArrowSquareOut size={11} weight="bold" />
        </Link>
      </div>
    </div>
  );
}

function PayloadSizeRow({ detail }: { detail: EventDetailResponse }) {
  if (detail.payload_size_bytes === undefined) return null;
  return (
    <div className="mt-3 border-t border-neutral-800 pt-2 text-[10px] text-neutral-500">
      Payload: {detail.payload_size_bytes} bytes (CBOR-encoded)
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

// source_reliability is the integer wire form of Q16.16 fixed-point.
// Endpoint values (0, 65536) are special-cased; intermediates rendered
// as the conventional decimal for readability.
function formatReliability(int: number): string {
  if (int === 0) return '0 (least)';
  if (int === 65536) return '1 (most)';
  return `${(int / 65536).toFixed(4)}`;
}
