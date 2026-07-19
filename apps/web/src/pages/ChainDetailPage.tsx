import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { decodeCbor } from '@epagoge/shared';
import { getChain, getEvent, listChainEvents, type ChainEvent } from '../api/endpoints.js';
import { formatCount, shortChainId, truncateHash } from '../util/format.js';

export function ChainDetailPage() {
  const { chainId = '' } = useParams<{ chainId: string }>();
  const chainQuery = useQuery({
    queryKey: ['chain', chainId],
    queryFn: () => getChain(chainId),
    enabled: chainId.length > 0,
  });
  const eventsQuery = useQuery({
    queryKey: ['chain-events', chainId],
    queryFn: () => listChainEvents(chainId, { limit: 100 }),
    enabled: chainId.length > 0,
  });

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← all chains
        </Link>
        <h1 className="mt-1 font-mono text-lg text-neutral-100" title={chainId}>
          {shortChainId(chainId)}
        </h1>
      </div>

      {chainQuery.data && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label="Events" value={formatCount(chainQuery.data.event_count_total)} />
          <StatCard label="Head marker" value={chainQuery.data.head_sequence_marker ?? '-'} mono />
          <StatCard
            label="Head hash"
            value={truncateHash(chainQuery.data.head_hash)}
            mono
            title={chainQuery.data.head_hash ?? undefined}
          />
          <StatCard label="Owner" value={chainQuery.data.owner_type} />
        </div>
      )}

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Events</h2>
          {eventsQuery.data && (
            <span className="text-xs text-neutral-500">
              showing {eventsQuery.data.events.length}
            </span>
          )}
        </div>

        {eventsQuery.isLoading && <SkeletonRows />}
        {eventsQuery.error && (
          <ErrorBox message={(eventsQuery.error as Error).message ?? 'failed to load events'} />
        )}
        {eventsQuery.data && (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/30">
            {eventsQuery.data.events.map((ev) => (
              <EventRow key={ev.event_hash} event={ev} />
            ))}
            {eventsQuery.data.events.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-neutral-500">
                No events on this chain yet.
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function EventRow({ event }: { event: ChainEvent }) {
  const [open, setOpen] = useState(false);
  const payloadQuery = useQuery({
    queryKey: ['event-payload', event.event_hash],
    queryFn: () => getEvent(event.event_hash, { includePayload: true }),
    enabled: open,
  });

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition hover:bg-neutral-900/60"
      >
        <div className="w-16 text-right font-mono text-xs text-neutral-500">
          #{event.causal_sequence_marker}
        </div>
        <div className="flex-1 min-w-0">
          <div className="truncate font-mono text-xs text-neutral-300" title={event.event_hash}>
            {truncateHash(event.event_hash)}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            <span className="rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
              {event.event_type}
            </span>
            <span className="ml-2 font-mono text-neutral-600">
              source: {truncateHash(event.source_id)}
            </span>
          </div>
        </div>
        <div className="text-xs text-neutral-600">{open ? '▾' : '▸'}</div>
      </button>
      {open && (
        <div className="border-t border-neutral-800 bg-neutral-950/60 px-4 py-3">
          <DefList>
            <DefRow label="event_hash" value={event.event_hash} mono />
            <DefRow label="source_id" value={event.source_id} mono />
            <DefRow label="payload_integrity" value={event.payload_integrity} mono />
            <DefRow
              label="causal_predecessors"
              value={
                event.causal_predecessors.length === 0
                  ? '(genesis)'
                  : event.causal_predecessors.map(truncateHash).join(', ')
              }
              mono={event.causal_predecessors.length > 0}
            />
          </DefList>
          <div className="mt-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
              Payload <span className="text-neutral-700">(CBOR-decoded)</span>
            </div>
            {payloadQuery.isLoading && (
              <div className="h-16 animate-pulse rounded bg-neutral-900" />
            )}
            {payloadQuery.error && (
              <ErrorBox
                message={(payloadQuery.error as Error).message ?? 'failed to load payload'}
              />
            )}
            {payloadQuery.data && <PayloadView data={payloadQuery.data} />}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Render the event payload. The API returns CBOR bytes as base64; we
 * decode them client-side so the user sees structured data, not a wall
 * of base64. If decoding fails (unknown event type, malformed bytes),
 * fall back to showing the raw base64 + the size so we don't crash.
 */
function PayloadView({ data }: { data: import('../api/endpoints.js').EventDetailResponse }) {
  if (!data.payload_base64) {
    return (
      <pre className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-500">
        (no payload bytes)
      </pre>
    );
  }
  let decoded: unknown;
  let decodeError: string | null = null;
  try {
    const binary = atob(data.payload_base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    decoded = decodeCbor<unknown>(bytes);
  } catch (err) {
    decodeError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      {decodeError ? (
        <div className="space-y-2">
          <div className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
            CBOR decode failed: {decodeError}
          </div>
          <pre className="max-h-48 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-[10px] text-neutral-500">
            {data.payload_base64}
          </pre>
        </div>
      ) : (
        <pre className="max-h-96 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-neutral-300">
          {stableJsonStringify(decoded)}
        </pre>
      )}
      <div className="mt-1 text-[10px] text-neutral-600">
        {data.payload_size_bytes ?? 0} bytes · integrity {truncateHash(data.payload_integrity)}
      </div>
    </>
  );
}

/** Like JSON.stringify but handles BigInt and Uint8Array which decodeCbor may emit. */
function stableJsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Uint8Array) {
        return Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
      }
      return v;
    },
    2,
  );
}

function StatCard({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div
        className={`mt-1 truncate text-sm text-neutral-100 ${mono ? 'font-mono' : ''}`}
        title={title}
      >
        {value}
      </div>
    </div>
  );
}

function DefList({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-1 gap-1 text-xs">{children}</dl>;
}

function DefRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className={`truncate text-neutral-300 ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-12 animate-pulse rounded bg-neutral-900" />
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
      {message}
    </div>
  );
}
