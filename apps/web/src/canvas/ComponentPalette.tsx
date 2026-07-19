// Component palette — Phase 0 sub-phase E, tranche E7.
//
// Per ADR-0034: the palette is a toolbox organized by use, not an
// inventory organized by existence. Categories map to composition
// phases (handle input → embed → position → normalize → attend →
// feedforward → activate → output), browse and search both work,
// categories collapse to focus on current work, and intentional
// overlaps (PositionEmbedding in embedding category alongside
// LearnedPositionEncoding in position-encoding category per
// ADR-0030) serve different mental models without colliding.

import { useMemo, useState, type DragEvent } from 'react';
import { MagnifyingGlass, CaretDown, CaretRight, X } from '@phosphor-icons/react';
import type { ComponentSpec, ComponentRegistry } from '@epagoge/components';

/**
 * Custom mime type for palette → canvas drag-and-drop. The canvas's
 * `onDrop` handler reads this exact key to fetch the component id.
 */
export const PALETTE_DRAG_MIME = 'application/x-epagoge-component-id';

interface Props {
  registry: ComponentRegistry;
  onAdd: (spec: ComponentSpec) => void;
}

/**
 * Category ordering follows composition flow rather than alphabetical
 * order. A user thinking "I'm assembling an architecture" walks roughly
 * left-to-right through these phases, so the palette lays them out
 * top-to-bottom in the same order. Unknown categories (Phase 3
 * cross-domain additions) appear at the end alphabetically.
 */
const CATEGORY_ORDER: readonly string[] = [
  'io', // Input / Output
  'embedding', // TokenEmbedding, PositionEmbedding, SegmentEmbedding
  'position-encoding', // Absolute, Learned (standalone PEs)
  'normalization', // LayerNorm, RMSNorm
  'attention', // 5 attention variants
  'ffn', // FeedForward, GatedFFN, MoEFFN
  'activation', // ReLU, GeLU, SiLU
];

interface PaletteCategory {
  readonly id: string;
  readonly specs: readonly ComponentSpec[];
}

export function ComponentPalette({ registry, onAdd }: Props) {
  const [search, setSearch] = useState('');
  // Per-category collapse state. Default is open; user collapses
  // categories they're not actively using.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const categories: readonly PaletteCategory[] = useMemo(() => {
    const groups = new Map<string, ComponentSpec[]>();
    for (const spec of registry.list()) {
      const arr = groups.get(spec.category) ?? [];
      arr.push(spec);
      groups.set(spec.category, arr);
    }
    // Sort within each category by component name for stable display.
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Order categories by the composition-flow list, with unknown
    // categories sorted alphabetically at the end.
    const ordered: PaletteCategory[] = [];
    for (const id of CATEGORY_ORDER) {
      const specs = groups.get(id);
      if (specs && specs.length > 0) ordered.push({ id, specs });
      groups.delete(id);
    }
    const leftover = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [id, specs] of leftover) ordered.push({ id, specs });
    return ordered;
  }, [registry]);

  // Search results — a flat list across all categories. Matches name,
  // id, or category. When non-empty, the palette renders a flat
  // search-results view instead of grouped categories.
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return null;
    const all = categories.flatMap((c) => c.specs);
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [categories, search]);

  function onDragStart(e: DragEvent<HTMLLIElement>, spec: ComponentSpec) {
    e.dataTransfer.setData(PALETTE_DRAG_MIME, spec.id);
    e.dataTransfer.effectAllowed = 'copy';
  }

  function toggleCategory(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className="border-line bg-panel/40 flex w-60 flex-col border-r">
      <div className="border-line border-b px-3 py-3">
        <div className="text-dim text-[10px] uppercase tracking-[0.18em]">Components</div>
        <SearchField value={search} onChange={setSearch} />
        <div className="text-dim/70 mt-1.5 text-[10px] leading-snug">
          Drag to canvas, or click to add at center.
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-2 py-3">
        {searchResults !== null ? (
          <SearchResults
            results={searchResults}
            onAdd={onAdd}
            onDragStart={onDragStart}
            query={search}
          />
        ) : (
          categories.map((cat) => (
            <CategorySection
              key={cat.id}
              category={cat}
              collapsed={collapsed.has(cat.id)}
              onToggle={() => toggleCategory(cat.id)}
              onAdd={onAdd}
              onDragStart={onDragStart}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative mt-2">
      <MagnifyingGlass
        size={12}
        weight="bold"
        className="text-dim pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search components…"
        aria-label="Search components"
        className="border-line bg-obsidian text-text placeholder:text-dim/60 focus:border-accent/50 w-full rounded border py-1 pl-7 pr-7 text-[11px] transition-colors focus:outline-none"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="text-dim hover:bg-panel-2 hover:text-text absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition"
        >
          <X size={10} weight="bold" />
        </button>
      )}
    </div>
  );
}

function CategorySection({
  category,
  collapsed,
  onToggle,
  onAdd,
  onDragStart,
}: {
  category: PaletteCategory;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: (spec: ComponentSpec) => void;
  onDragStart: (e: DragEvent<HTMLLIElement>, spec: ComponentSpec) => void;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-panel-2/60 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition"
      >
        {collapsed ? (
          <CaretRight size={10} weight="bold" className="text-dim/70" />
        ) : (
          <CaretDown size={10} weight="bold" className="text-dim/70" />
        )}
        <span className="text-dim text-[10px] font-medium uppercase tracking-[0.18em]">
          {category.id}
        </span>
        <span className="text-dim/70 ml-auto font-mono text-[9px]">{category.specs.length}</span>
      </button>
      {!collapsed && (
        <ul className="mt-1 space-y-1 px-0.5">
          {category.specs.map((spec) => (
            <PaletteItem key={spec.id} spec={spec} onAdd={onAdd} onDragStart={onDragStart} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SearchResults({
  results,
  onAdd,
  onDragStart,
  query,
}: {
  results: readonly ComponentSpec[];
  onAdd: (spec: ComponentSpec) => void;
  onDragStart: (e: DragEvent<HTMLLIElement>, spec: ComponentSpec) => void;
  query: string;
}) {
  if (results.length === 0) {
    return <div className="text-dim px-2 py-3 text-[11px]">No components match "{query}".</div>;
  }
  return (
    <div>
      <div className="text-dim px-1 pb-1 text-[10px] uppercase tracking-[0.18em]">
        {results.length} {results.length === 1 ? 'match' : 'matches'}
      </div>
      <ul className="space-y-1 px-0.5">
        {results.map((spec) => (
          <PaletteItem
            key={spec.id}
            spec={spec}
            onAdd={onAdd}
            onDragStart={onDragStart}
            showCategory
          />
        ))}
      </ul>
    </div>
  );
}

function PaletteItem({
  spec,
  onAdd,
  onDragStart,
  showCategory,
}: {
  spec: ComponentSpec;
  onAdd: (spec: ComponentSpec) => void;
  onDragStart: (e: DragEvent<HTMLLIElement>, spec: ComponentSpec) => void;
  showCategory?: boolean;
}) {
  return (
    <li draggable onDragStart={(e) => onDragStart(e, spec)}>
      <button
        type="button"
        onClick={() => onAdd(spec)}
        title={spec.description}
        className="border-line bg-panel hover:border-accent/40 hover:bg-panel-2 flex w-full cursor-grab flex-col items-stretch gap-0.5 rounded border px-2 py-1.5 text-left transition-colors active:cursor-grabbing"
      >
        <div className="flex items-baseline gap-1.5">
          <span className="text-text text-[12px] font-medium">{spec.name}</span>
          {showCategory && (
            <span className="text-dim text-[9px] uppercase tracking-[0.18em]">{spec.category}</span>
          )}
        </div>
        <span className="text-dim line-clamp-2 text-[10px] leading-snug">{spec.description}</span>
      </button>
    </li>
  );
}
