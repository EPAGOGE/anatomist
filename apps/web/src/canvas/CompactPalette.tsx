// CompactPalette — Pitch Sprint Day 10
//
// Vertical icon-strip palette per user direction:
//   "you should have small squarish icons on the screen in a toolbar
//    to the side or at the bottom or top that pull the tools you know
//    and can hover over if needed a description. the canvas is the art"
//
// Each component category renders as a single icon button in a ~56px
// strip. Hover shows a Radix Tooltip with the category name. Click
// opens a Radix Popover anchored to the icon, listing the components
// in that category as PaletteItem cards (lifted from ComponentPalette).
//
// Canvas reclaims the ~184px the old 240px-wide palette was eating.

import { useMemo, useState, type DragEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  MagnifyingGlass,
  ArrowsInLineHorizontal,
  BookOpenText,
  MapPin,
  Waveform,
  Eye,
  CirclesFour,
  Lightning,
  Cube,
  X,
  type Icon as PhIcon,
} from '@phosphor-icons/react';
import type { ComponentSpec, ComponentRegistry } from '@epagoge/components';
import { PALETTE_DRAG_MIME } from './ComponentPalette.js';

interface Props {
  registry: ComponentRegistry;
  onAdd: (spec: ComponentSpec) => void;
}

// Icon mapping per category. Matches the platform's iconography
// vocabulary: distinct shapes per component family for scanability.
const CATEGORY_ICON: Record<string, PhIcon> = {
  io: ArrowsInLineHorizontal,
  embedding: BookOpenText,
  'position-encoding': MapPin,
  normalization: Waveform,
  attention: Eye,
  ffn: CirclesFour,
  activation: Lightning,
};

const CATEGORY_LABEL: Record<string, string> = {
  io: 'Input / Output',
  embedding: 'Embedding',
  'position-encoding': 'Position encoding',
  normalization: 'Normalization',
  attention: 'Attention',
  ffn: 'Feed-forward',
  activation: 'Activation',
};

const CATEGORY_ORDER: readonly string[] = [
  'io',
  'embedding',
  'position-encoding',
  'normalization',
  'attention',
  'ffn',
  'activation',
];

interface CategoryGroup {
  readonly id: string;
  readonly label: string;
  readonly Icon: PhIcon;
  readonly specs: readonly ComponentSpec[];
}

export function CompactPalette({ registry, onAdd }: Props) {
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const groups: readonly CategoryGroup[] = useMemo(() => {
    const byCat = new Map<string, ComponentSpec[]>();
    for (const spec of registry.list()) {
      const arr = byCat.get(spec.category) ?? [];
      arr.push(spec);
      byCat.set(spec.category, arr);
    }
    for (const arr of byCat.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    const out: CategoryGroup[] = [];
    for (const id of CATEGORY_ORDER) {
      const specs = byCat.get(id);
      if (!specs?.length) continue;
      out.push({
        id,
        label: CATEGORY_LABEL[id] ?? id,
        Icon: CATEGORY_ICON[id] ?? Cube,
        specs,
      });
      byCat.delete(id);
    }
    for (const [id, specs] of byCat) {
      out.push({
        id,
        label: CATEGORY_LABEL[id] ?? id,
        Icon: CATEGORY_ICON[id] ?? Cube,
        specs,
      });
    }
    return out;
  }, [registry]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return groups
      .flatMap((g) => g.specs)
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
  }, [groups, search]);

  function onDragStart(e: DragEvent<HTMLLIElement>, spec: ComponentSpec) {
    e.dataTransfer.setData(PALETTE_DRAG_MIME, spec.id);
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <aside className="border-line bg-panel/60 flex w-14 shrink-0 flex-col items-center border-r py-2">
        {/* Search */}
        <Popover.Root open={searchOpen} onOpenChange={setSearchOpen}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label="Search components"
                  className="text-dim hover:text-text hover:bg-panel-2 group flex h-10 w-10 items-center justify-center rounded-md transition-colors data-[state=open]:bg-panel-2 data-[state=open]:text-accent"
                >
                  <MagnifyingGlass size={16} weight="bold" />
                </button>
              </Popover.Trigger>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="right"
                sideOffset={8}
                className="glass text-text z-50 rounded-md px-2 py-1 text-[11px]"
              >
                Search
                <Tooltip.Arrow className="fill-[var(--color-line)]" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <Popover.Portal>
            <Popover.Content
              side="right"
              align="start"
              sideOffset={8}
              className="glass z-50 w-72 rounded-lg p-3 shadow-2xl"
            >
              <div className="relative mb-2">
                <MagnifyingGlass
                  size={12}
                  weight="bold"
                  className="text-dim pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
                />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search all components…"
                  className="border-line bg-obsidian text-text placeholder:text-dim/60 focus:border-accent/50 w-full rounded border py-1.5 pl-7 pr-7 text-[12px] focus:outline-none"
                />
                {search.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    className="text-dim hover:bg-panel-2 hover:text-text absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition"
                  >
                    <X size={10} weight="bold" />
                  </button>
                )}
              </div>
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {searchResults === null && (
                  <div className="text-dim px-1 py-2 text-[11px]">
                    Type to search across all categories.
                  </div>
                )}
                {searchResults !== null && searchResults.length === 0 && (
                  <div className="text-dim px-1 py-2 text-[11px]">
                    No components match "{search}".
                  </div>
                )}
                {searchResults?.map((spec) => (
                  <CompactPaletteItem
                    key={spec.id}
                    spec={spec}
                    onAdd={(s) => {
                      onAdd(s);
                      setSearchOpen(false);
                    }}
                    onDragStart={onDragStart}
                    showCategory
                  />
                ))}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        {/* hairline separator */}
        <div className="border-line my-2 w-8 border-t" aria-hidden />

        {/* Category icons */}
        {groups.map((group) => (
          <Popover.Root key={group.id}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    aria-label={group.label}
                    className="text-dim hover:text-text hover:bg-panel-2 mb-1 flex h-10 w-10 items-center justify-center rounded-md transition-colors data-[state=open]:bg-panel-2 data-[state=open]:text-accent"
                  >
                    <group.Icon size={18} weight="duotone" />
                  </button>
                </Popover.Trigger>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="right"
                  sideOffset={8}
                  className="glass text-text z-50 rounded-md px-2 py-1 text-[11px]"
                >
                  {group.label}
                  <span className="text-dim ml-1.5 font-mono text-[10px]">
                    {group.specs.length}
                  </span>
                  <Tooltip.Arrow className="fill-[var(--color-line)]" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
            <Popover.Portal>
              <Popover.Content
                side="right"
                align="start"
                sideOffset={8}
                className="glass z-50 w-64 rounded-lg p-3 shadow-2xl"
              >
                <div className="text-dim mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em]">
                  <span>{group.label}</span>
                  <span className="font-mono">{group.specs.length}</span>
                </div>
                <div className="max-h-80 space-y-1 overflow-y-auto">
                  {group.specs.map((spec) => (
                    <CompactPaletteItem
                      key={spec.id}
                      spec={spec}
                      onAdd={onAdd}
                      onDragStart={onDragStart}
                    />
                  ))}
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ))}
      </aside>
    </Tooltip.Provider>
  );
}

function CompactPaletteItem({
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
    <ul className="list-none">
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
              <span className="text-dim text-[9px] uppercase tracking-[0.15em]">
                {spec.category}
              </span>
            )}
          </div>
          <span className="text-dim line-clamp-2 text-[10px] leading-snug">{spec.description}</span>
        </button>
      </li>
    </ul>
  );
}
