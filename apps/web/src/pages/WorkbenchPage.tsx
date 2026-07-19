// MI Workbench — Subsystem 1 (Model Library + Loading).
//
// LM-Studio-style searchable catalog of models the platform can work with,
// each card showing the available MI tools (TransformerLens, Gemma Scope,
// NLA, custom SAEs). Click a card's "load" button to ask the backend to
// pull weights and warm the model — errors (missing HF_TOKEN, unaccepted
// license, OOM) surface inline on the card.
//
// Chat with the loaded model happens on the CANVAS (bottom-docked command
// bar — see components/chat/CanvasChatDock.tsx), not here. This page is the
// model library proper: find a model, see its tools, load it.
//
// Backend: apps/mi-backend (FastAPI). If unreachable, the page renders a
// clear "Start the backend" state with the exact command to run.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MagnifyingGlass, Plugs, Sparkle } from '@phosphor-icons/react';
import { getHealth, getLoadedModels, listModels, type ModelEntry } from '../api/mi-endpoints.js';
import { getMiBaseUrl, type MiApiError } from '../api/mi-client.js';
import { ModelCard } from '../components/workbench/ModelCard.js';

export function WorkbenchPage() {
  const [query, setQuery] = useState('');
  const [familyFilter, setFamilyFilter] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: ['mi-health'],
    queryFn: getHealth,
    retry: false,
    refetchInterval: 10_000,
  });

  const modelsQuery = useQuery({
    queryKey: ['mi-models'],
    queryFn: listModels,
    enabled: healthQuery.isSuccess,
  });

  const loadedQuery = useQuery({
    queryKey: ['mi-loaded'],
    queryFn: getLoadedModels,
    enabled: healthQuery.isSuccess,
    refetchInterval: 5_000,
  });

  const families = useMemo(() => {
    const set = new Set<string>();
    modelsQuery.data?.models.forEach((m) => set.add(m.family));
    return Array.from(set).sort();
  }, [modelsQuery.data]);

  const filtered = useMemo(() => {
    const all = modelsQuery.data?.models ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((m) => {
      if (familyFilter && m.family !== familyFilter) return false;
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        m.display_name.toLowerCase().includes(q) ||
        m.family.toLowerCase().includes(q) ||
        m.notes.toLowerCase().includes(q)
      );
    });
  }, [modelsQuery.data, query, familyFilter]);

  const loadedSet = useMemo(() => new Set(loadedQuery.data?.loaded ?? []), [loadedQuery.data]);

  return (
    <div className="space-y-6">
      <Header />

      {!healthQuery.isSuccess ? (
        <BackendUnreachablePanel error={healthQuery.error as unknown as MiApiError | null} />
      ) : (
        <>
          <Toolbar
            query={query}
            onQuery={setQuery}
            families={families}
            familyFilter={familyFilter}
            onFamilyFilter={setFamilyFilter}
            total={modelsQuery.data?.models.length ?? 0}
            filtered={filtered.length}
            loadedCount={loadedSet.size}
          />

          {modelsQuery.isLoading && <CatalogSkeleton />}
          {modelsQuery.error && (
            <ErrorBanner message={(modelsQuery.error as unknown as MiApiError).message} />
          )}
          {modelsQuery.data && <ModelGrid models={filtered} loadedSet={loadedSet} />}
        </>
      )}
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-text flex items-center gap-2 text-2xl font-bold">
        <Sparkle size={22} weight="duotone" className="text-accent" />
        Model Library
      </h1>
      <p className="text-dim mt-1 text-sm">
        Load a model to probe and chat with it. Chatting + probing happens on the canvas; this is
        where you choose what runs.
      </p>
    </header>
  );
}

function Toolbar({
  query,
  onQuery,
  families,
  familyFilter,
  onFamilyFilter,
  total,
  filtered,
  loadedCount,
}: {
  query: string;
  onQuery: (q: string) => void;
  families: string[];
  familyFilter: string | null;
  onFamilyFilter: (f: string | null) => void;
  total: number;
  filtered: number;
  loadedCount: number;
}) {
  return (
    <div className="border-line bg-panel/60 flex flex-wrap items-center gap-3 rounded-lg border p-3 backdrop-blur">
      <div className="border-line bg-panel-2 focus-within:border-accent/60 flex flex-1 items-center gap-2 rounded border px-2.5 py-1.5 transition">
        <MagnifyingGlass size={14} weight="bold" className="text-dim" />
        <input
          type="text"
          placeholder="search by name, id, family, notes…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="text-text placeholder:text-dim/60 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onFamilyFilter(null)}
          className={[
            'rounded border px-2 py-1 text-[11px] transition',
            familyFilter === null
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-line bg-panel-2 text-dim hover:text-text',
          ].join(' ')}
        >
          all
        </button>
        {families.map((family) => (
          <button
            key={family}
            type="button"
            onClick={() => onFamilyFilter(familyFilter === family ? null : family)}
            className={[
              'rounded border px-2 py-1 text-[11px] transition',
              familyFilter === family
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-line bg-panel-2 text-dim hover:text-text',
            ].join(' ')}
          >
            {family}
          </button>
        ))}
      </div>

      <div className="text-dim text-[10px] uppercase tracking-[0.15em]">
        <span className="text-text font-mono normal-case tracking-normal">{filtered}</span> /
        <span className="font-mono normal-case tracking-normal"> {total}</span> ·{' '}
        <span className="text-text font-mono normal-case tracking-normal">{loadedCount}</span>{' '}
        loaded
      </div>
    </div>
  );
}

function ModelGrid({ models, loadedSet }: { models: ModelEntry[]; loadedSet: Set<string> }) {
  if (models.length === 0) {
    return (
      <div className="border-line bg-panel/40 rounded-lg border p-8 text-center">
        <p className="text-dim text-sm">No models match the current filters.</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {models.map((model) => (
        <ModelCard key={model.id} model={model} isLoaded={loadedSet.has(model.id)} />
      ))}
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="border-line bg-panel h-40 animate-pulse rounded-lg border p-4">
          <div className="bg-line mb-3 h-4 w-2/3 rounded" />
          <div className="bg-line mb-3 h-3 w-1/2 rounded" />
          <div className="bg-line h-3 w-full rounded" />
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="border-warn/30 bg-warn/5 text-warn rounded-lg border px-4 py-3 text-sm">
      {message}
    </div>
  );
}

function BackendUnreachablePanel({ error }: { error: MiApiError | null }) {
  return (
    <div className="border-warn/30 bg-warn/5 space-y-3 rounded-lg border p-5">
      <div className="flex items-center gap-2">
        <Plugs size={18} weight="duotone" className="text-warn" />
        <h2 className="text-text text-sm font-semibold">MI backend unreachable</h2>
      </div>
      <p className="text-dim text-xs leading-relaxed">
        Expected at <code className="text-text font-mono">{getMiBaseUrl()}</code>. Start it from the
        platform repo with:
      </p>
      <pre className="text-text border-line bg-panel-2 overflow-x-auto rounded border p-3 font-mono text-[11px] leading-relaxed">
        {`cd apps/mi-backend
.venv/bin/uvicorn main:app --reload --port 8765`}
      </pre>
      {error && error.status !== 0 && (
        <p className="text-warn text-[11px]">
          ({error.status}) {error.message}
        </p>
      )}
      <p className="text-dim text-[11px]">
        This page polls every 10 seconds; once the backend is up, it&rsquo;ll auto-connect.
      </p>
    </div>
  );
}
