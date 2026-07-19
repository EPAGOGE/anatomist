// Property inspector — Phase 0 sub-phase E, tranche E6.
//
// Per ADR-0033: the inspector is an instrument panel, not a form. It
// anticipates what the user wants (sensible defaults, common
// properties prominent, constraints prevented rather than detected),
// respects their intelligence (clear organization, education available
// on demand not imposed, full control accessible), and makes the
// likely path frictionless while keeping depth reachable.
//
// Key behaviors:
//   - Primary properties (PropertySpec.group === undefined) render in
//     the always-visible primary section.
//   - Secondary properties render in collapsible sections per the
//     ComponentSpec.propertyGroups declaration. defaultCollapsed
//     starts each section closed; the section auto-expands when any
//     of its properties has a non-default value (signal of
//     demonstrated user interest).
//   - Defaults are visibly marked. A user never wonders whether a
//     property is set or empty.
//   - Enum properties with ≤4 choices render as a segmented control
//     (visible options, one-click pick) rather than a dropdown.
//   - Properties with `divides` hint show valid divisors of the
//     anchor property as quick-pick chips alongside the input. The
//     user picks a valid value rather than entering an invalid one
//     and learning later.
//   - Descriptions live on hover (info tooltip icon), not always
//     visible. Practitioners don't need them; novices reach for them.

import { useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import { Info, CaretRight, CaretDown, ArrowCounterClockwise } from '@phosphor-icons/react';
import type {
  ComponentSpec,
  PropertySpec,
  PropertyValue,
  PropertyGroup,
  ResolvedProperties,
} from '@epagoge/components';
import { formatSignature } from '@epagoge/components';
import type { ArchitectureNode } from './nodes.js';

interface Props {
  node: ArchitectureNode | null;
  onChange: (id: string, value: PropertyValue) => void;
}

export function PropertyInspector({ node, onChange }: Props) {
  if (!node) {
    return (
      <div className="px-4 py-4 text-xs text-neutral-500">
        Select a node to edit its properties.
      </div>
    );
  }
  const spec: ComponentSpec = node.spec;
  const props = node.properties as ResolvedProperties;

  // Partition properties into primary (no group) and per-group buckets.
  const { primary, byGroup } = useMemo(() => {
    const primary: PropertySpec[] = [];
    const byGroup = new Map<string, PropertySpec[]>();
    for (const p of spec.properties) {
      if (p.group === undefined) primary.push(p);
      else {
        const arr = byGroup.get(p.group) ?? [];
        arr.push(p);
        byGroup.set(p.group, arr);
      }
    }
    return { primary, byGroup };
  }, [spec]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — orient before adjust. */}
      <header className="border-b border-neutral-800 px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500">{spec.category}</div>
        <h3 className="text-sm font-semibold text-neutral-100">{spec.name}</h3>
        <p className="mt-1 text-[11px] leading-snug text-neutral-500">{spec.description}</p>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Primary section — always visible. */}
        {primary.length > 0 && (
          <section className="space-y-3 px-4 py-3">
            {primary.map((prop) => (
              <PropertyControl
                key={prop.id}
                spec={prop}
                value={props[prop.id]}
                allProps={props}
                onChange={(v) => onChange(prop.id, v)}
              />
            ))}
          </section>
        )}

        {/* Secondary groups — collapsible sections. */}
        {(spec.propertyGroups ?? []).map((group) => {
          const groupProps = byGroup.get(group.id) ?? [];
          if (groupProps.length === 0) return null;
          return (
            <CollapsibleGroup
              key={group.id}
              group={group}
              properties={groupProps}
              propsState={props}
              onChange={onChange}
            />
          );
        })}

        {spec.properties.length === 0 && (
          <div className="px-4 py-3 text-xs text-neutral-500">
            This component has no configurable properties.
          </div>
        )}

        {/* Signature — read-only, at the end. */}
        <section className="border-t border-neutral-800 px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">Signature</div>
          <div className="mt-2 space-y-1 font-mono text-[10px] text-neutral-400">
            {spec.inputs.length === 0 && spec.outputs.length === 0 && (
              <div className="text-neutral-600">(no ports)</div>
            )}
            {spec.inputs.map((p) => {
              const sig = p.signature(props);
              return (
                <div key={`in-${p.id}`}>
                  <span className="text-neutral-600">in.{p.id}</span>{' '}
                  <span className="text-neutral-400">{formatSignature(sig)}</span>
                </div>
              );
            })}
            {spec.outputs.map((p) => {
              const sig = p.signature(props);
              return (
                <div key={`out-${p.id}`}>
                  <span className="text-neutral-600">out.{p.id}</span>{' '}
                  <span className="text-neutral-400">{formatSignature(sig)}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function CollapsibleGroup({
  group,
  properties,
  propsState,
  onChange,
}: {
  group: PropertyGroup;
  properties: readonly PropertySpec[];
  propsState: ResolvedProperties;
  onChange: (id: string, v: PropertyValue) => void;
}) {
  // Auto-expand when any property in the group has a non-default
  // value (signal of demonstrated user interest). Per the brief: "If
  // a user expands it and sets RoPE, it stays expanded because they've
  // shown they care." We compose two signals:
  //   - userToggle: the user's most recent explicit toggle, or null
  //     when they haven't touched the section yet.
  //   - groupHasUserValue: derived from props each render. When the
  //     user sets a property in the group, this becomes true and
  //     forces the section open regardless of userToggle.
  const groupHasUserValue = useMemo(
    () =>
      properties.some((p) => propsState[p.id] !== undefined && propsState[p.id] !== p.defaultValue),
    [properties, propsState],
  );
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const open = groupHasUserValue ? true : (userToggle ?? !group.defaultCollapsed);

  return (
    <section className="border-t border-neutral-800">
      <button
        type="button"
        onClick={() => setUserToggle(!open)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left transition hover:bg-neutral-900/50"
      >
        {open ? (
          <CaretDown size={12} weight="bold" className="text-neutral-500" />
        ) : (
          <CaretRight size={12} weight="bold" className="text-neutral-500" />
        )}
        <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-300">
          {group.label}
        </span>
        {!open && groupHasUserValue && (
          <span
            title="This section has user-set values"
            className="ml-1 h-1.5 w-1.5 rounded-full bg-emerald-500"
          />
        )}
        {group.description && (
          <span className="ml-auto text-[10px] text-neutral-600">
            {properties.length} {properties.length === 1 ? 'property' : 'properties'}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-3 pt-1">
          {group.description && (
            <p className="text-[10px] leading-snug text-neutral-600">{group.description}</p>
          )}
          {properties.map((prop) => (
            <PropertyControl
              key={prop.id}
              spec={prop}
              value={propsState[prop.id]}
              allProps={propsState}
              onChange={(v) => onChange(prop.id, v)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Per-property controls.
// ---------------------------------------------------------------------

function PropertyControl({
  spec,
  value,
  allProps,
  onChange,
}: {
  spec: PropertySpec;
  value: PropertyValue | undefined;
  allProps: ResolvedProperties;
  onChange: (v: PropertyValue) => void;
}) {
  const v = value ?? spec.defaultValue;
  const isDefault = v === spec.defaultValue;

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11px] font-medium text-neutral-200">{spec.label}</span>
        {spec.description && (
          <span
            title={spec.description}
            className="cursor-help text-neutral-600 hover:text-neutral-400"
          >
            <Info size={11} weight="duotone" />
          </span>
        )}
        {isDefault && <DefaultMarker />}
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange(spec.defaultValue)}
            title={`Reset to default (${displayValue(spec.defaultValue)})`}
            className="ml-auto text-neutral-600 transition hover:text-neutral-300"
          >
            <ArrowCounterClockwise size={11} weight="bold" />
          </button>
        )}
        <span className="ml-auto font-mono text-[9px] text-neutral-700">{spec.id}</span>
      </div>

      {renderControl(spec, v, allProps, onChange)}
    </div>
  );
}

function renderControl(
  spec: PropertySpec,
  v: PropertyValue,
  allProps: ResolvedProperties,
  onChange: (v: PropertyValue) => void,
): ReactElement {
  if (spec.kind === 'bool') {
    return <BoolToggle value={v as boolean} onChange={onChange} />;
  }
  if (spec.kind === 'enum') {
    const choices = spec.choices ?? [];
    if (choices.length <= 4) {
      return <SegmentedControl choices={choices} value={String(v)} onChange={onChange} />;
    }
    return <Dropdown choices={choices} value={String(v)} onChange={onChange} />;
  }
  if (spec.kind === 'int' || spec.kind === 'float') {
    return <NumericInput spec={spec} value={Number(v)} allProps={allProps} onChange={onChange} />;
  }
  return <StringInput value={String(v)} onChange={onChange} />;
}

function DefaultMarker() {
  return (
    <span
      title="Default value"
      className="rounded bg-neutral-800/50 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider text-neutral-500"
    >
      default
    </span>
  );
}

const INPUT_CLASS =
  'w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none';

function StringInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      className={INPUT_CLASS}
    />
  );
}

function BoolToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 rounded-full transition ${
          value ? 'bg-emerald-600' : 'bg-neutral-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${
            value ? 'left-4' : 'left-0.5'
          }`}
        />
      </button>
      <span className="text-[11px] text-neutral-400">{value ? 'true' : 'false'}</span>
    </div>
  );
}

function SegmentedControl({
  choices,
  value,
  onChange,
}: {
  choices: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded border border-neutral-800 bg-neutral-950 p-0.5">
      {choices.map((c) => {
        const active = c === value;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`flex-1 rounded px-2 py-1 text-[10px] font-medium transition ${
              active
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300'
            }`}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function Dropdown({
  choices,
  value,
  onChange,
}: {
  choices: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      className={INPUT_CLASS}
    >
      {choices.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

function NumericInput({
  spec,
  value,
  allProps,
  onChange,
}: {
  spec: PropertySpec;
  value: number;
  allProps: ResolvedProperties;
  onChange: (v: number) => void;
}) {
  const isInt = spec.kind === 'int';
  // Divisibility-aware quick picks. When this property has a `divides`
  // hint, compute the divisors of the anchor property's current value
  // and offer them as one-click chips. The user picks a valid value
  // rather than entering an invalid one and seeing a deterministic
  // error after the fact.
  const divisors = useMemo(() => {
    if (!spec.divides) return null;
    const anchor = allProps[spec.divides];
    if (typeof anchor !== 'number' || !Number.isFinite(anchor) || anchor < 1) return null;
    return rankedDivisors(Math.trunc(anchor));
  }, [spec.divides, allProps]);

  return (
    <div>
      <input
        type="number"
        step={isInt ? 1 : 'any'}
        min={spec.min ?? undefined}
        max={spec.max ?? undefined}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const n = e.target.value === '' ? 0 : Number(e.target.value);
          onChange(isInt ? Math.trunc(n) : n);
        }}
        className={INPUT_CLASS}
      />
      {divisors !== null && divisors.length > 0 && (
        <div className="mt-1.5">
          <div className="text-[9px] uppercase tracking-wider text-neutral-600">
            valid divisors of {spec.divides} ({allProps[spec.divides!]})
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {divisors.map((d) => {
              const active = d === value;
              const headDim = Math.floor(Number(allProps[spec.divides!] ?? 0) / d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onChange(d)}
                  title={`${spec.divides} / ${spec.id} = ${headDim}`}
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-mono transition ${
                    active
                      ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200'
                      : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800'
                  }`}
                >
                  {d}
                  <span className="ml-1 text-neutral-600">→{headDim}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function displayValue(v: PropertyValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * Divisors of `n` ranked for transformer authoring: common head
 * counts (8/16/12/32/...) first, then the rest in numeric order.
 * Matches the validator's suggestion logic so the UI hint and the
 * deterministic error suggestions agree.
 */
function rankedDivisors(n: number): readonly number[] {
  if (!Number.isFinite(n) || n < 1) return [];
  const all: number[] = [];
  for (let d = 1; d <= n; d++) {
    if (n % d === 0) all.push(d);
  }
  // Priority list matches validation/index.ts suggestDivisors().
  const priority = [8, 16, 12, 4, 32, 24, 64, 2, 6, 48];
  const ranked = all.slice().sort((a, b) => {
    const pa = priority.indexOf(a);
    const pb = priority.indexOf(b);
    if (pa !== -1 && pb !== -1) return pa - pb;
    if (pa !== -1) return -1;
    if (pb !== -1) return 1;
    return a - b;
  });
  // Cap so the chip row stays compact.
  return ranked.slice(0, 8);
}
