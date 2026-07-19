// Load-saved picker — opens a dialog listing the user's past
// architecture saves and hydrates the chosen one into the canvas.
//
// Per E2-2: saves without retrieval are write-only. This dialog is
// the retrieval surface. Each row shows the architecture name, save
// timestamp, node/edge counts, and the truncated event hash. Click
// → hydrate.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getArchitecture, listArchitectures, type ArchitectureSummary } from '../api/endpoints.js';
import { formatTimestamp, truncateHash } from '../util/format.js';
import type { ApiError } from '../api/client.js';

/**
 * Payload handed to onLoad. Nodes/edges shapes match the canvas's
 * GraphSpec format; the CanvasPage forwards them straight to
 * hydrateEditorFromGraphSpec.
 */
export interface LoadDialogResult {
  architecture_id: string;
  name: string;
  description?: string;
  nodes: Array<{
    id: string;
    componentId: string;
    properties: Record<string, string | number | boolean>;
  }>;
  edges: Array<{
    id: string;
    source: { nodeId: string; portId: string };
    target: { nodeId: string; portId: string };
  }>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onLoad: (payload: LoadDialogResult) => void;
}

export function LoadDialog({ open, onClose, onLoad }: Props) {
  const [loadingHash, setLoadingHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['architectures-list'],
    queryFn: () => listArchitectures(50),
    enabled: open,
  });

  if (!open) return null;

  async function pick(eventHash: string) {
    setError(null);
    setLoadingHash(eventHash);
    try {
      const full = await getArchitecture(eventHash);
      onLoad({
        architecture_id: full.payload.architecture_id,
        name: full.payload.name,
        ...(full.payload.description ? { description: full.payload.description } : {}),
        nodes: full.payload.nodes,
        edges: full.payload.edges,
      });
      onClose();
    } catch (err) {
      setError((err as ApiError).message ?? 'failed to load');
    } finally {
      setLoadingHash(null);
    }
  }

  // Group by architecture_id so a multi-save lineage shows once with
  // its history nested.
  const grouped = groupByArchitectureId(listQuery.data?.architectures ?? []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-100">Load saved architecture</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Each row is one save on the architecture-composition chain.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {listQuery.isLoading && (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="h-14 animate-pulse rounded bg-neutral-800/60" />
              ))}
            </div>
          )}
          {listQuery.error && (
            <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {(listQuery.error as unknown as ApiError).message ?? 'failed to list'}
            </div>
          )}
          {listQuery.data && grouped.length === 0 && (
            <div className="flex h-32 flex-col items-center justify-center gap-1 text-center text-sm text-neutral-500">
              <div>No saved architectures yet.</div>
              <div className="text-xs text-neutral-600">
                Compose something on the canvas and hit Save to populate this list.
              </div>
            </div>
          )}
          {grouped.map((group) => (
            <ArchitectureGroup
              key={group.architectureId}
              group={group}
              loadingHash={loadingHash}
              onPick={pick}
            />
          ))}
        </div>

        {error && (
          <div className="border-t border-red-900/60 bg-red-950/30 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

interface Group {
  architectureId: string;
  saves: ArchitectureSummary[];
}

function groupByArchitectureId(items: ArchitectureSummary[]): Group[] {
  const map = new Map<string, ArchitectureSummary[]>();
  for (const item of items) {
    const id = item.architecture_id ?? '(unknown)';
    const arr = map.get(id) ?? [];
    arr.push(item);
    map.set(id, arr);
  }
  return Array.from(map.entries()).map(([architectureId, saves]) => ({
    architectureId,
    // Latest save (highest marker) first.
    saves: saves.sort((a, b) =>
      Number(BigInt(b.causal_sequence_marker) - BigInt(a.causal_sequence_marker)),
    ),
  }));
}

function ArchitectureGroup({
  group,
  loadingHash,
  onPick,
}: {
  group: Group;
  loadingHash: string | null;
  onPick: (eventHash: string) => void;
}) {
  const latest = group.saves[0]!;
  const olderCount = group.saves.length - 1;
  return (
    <div className="mb-2 overflow-hidden rounded border border-neutral-800 bg-neutral-950">
      <button
        type="button"
        onClick={() => onPick(latest.event_hash)}
        disabled={loadingHash === latest.event_hash}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-neutral-900 disabled:opacity-50"
      >
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium text-neutral-100">{latest.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
            <span>{latest.node_count} nodes</span>
            <span className="text-neutral-700">·</span>
            <span>{latest.edge_count} edges</span>
            {latest.occurred_at && (
              <>
                <span className="text-neutral-700">·</span>
                <span>{formatTimestamp(latest.occurred_at)}</span>
              </>
            )}
          </div>
        </div>
        <div className="font-mono text-[10px] text-neutral-600" title={latest.event_hash}>
          {truncateHash(latest.event_hash)}
        </div>
        {loadingHash === latest.event_hash && (
          <span className="text-[10px] text-emerald-400">loading…</span>
        )}
      </button>
      {olderCount > 0 && (
        <details className="border-t border-neutral-800 bg-neutral-900/40">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-neutral-500 hover:text-neutral-300">
            {olderCount} earlier {olderCount === 1 ? 'save' : 'saves'} of this architecture
          </summary>
          <ul className="divide-y divide-neutral-800/60">
            {group.saves.slice(1).map((s) => (
              <li key={s.event_hash}>
                <button
                  type="button"
                  onClick={() => onPick(s.event_hash)}
                  disabled={loadingHash === s.event_hash}
                  className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-[11px] text-neutral-400 transition hover:bg-neutral-900 disabled:opacity-50"
                >
                  <span className="flex-1 truncate">{s.name}</span>
                  {s.occurred_at && (
                    <span className="text-neutral-600">{formatTimestamp(s.occurred_at)}</span>
                  )}
                  <span className="font-mono text-neutral-600">{truncateHash(s.event_hash)}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
