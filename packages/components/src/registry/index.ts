// Component registry — domain-agnostic primitive specifications.
//
// A ComponentSpec defines what a single draggable node in the canvas
// IS: its identity, its category, its I/O ports (each with a tensor
// signature), its configurable properties, and how it codegens.
//
// This module is DOMAIN-AGNOSTIC. Nothing here knows about transformers,
// attention, normalization, etc. ML primitives live in
// `./domains/ml/*` and register themselves into a registry instance.
// Phase 3 cross-domain expansion adds `./domains/eng/*` or whatever else
// without touching this file.
//
// The codegen surface is a callback that returns IR (intermediate
// representation) suitable for a backend to translate. Backends live
// in `@epagoge/codegen`; the component spec is backend-agnostic.

import { z } from 'zod';
import type { TensorSignature } from '../tensor/index.js';

/**
 * One configurable parameter on a component (e.g. `num_heads`,
 * `dropout`, `embed_dim`). Backend codegen reads these.
 */
export const PropertyKindSchema = z.enum(['int', 'float', 'bool', 'string', 'enum']);
export type PropertyKind = z.infer<typeof PropertyKindSchema>;

export interface PropertySpec {
  /** Stable identifier referenced from codegen + UI. */
  readonly id: string;
  /** Human-readable label shown in the property inspector. */
  readonly label: string;
  /** Type discriminator. Backend codegen uses this. */
  readonly kind: PropertyKind;
  /** Default value applied when the node is dropped. JSON-serializable. */
  readonly defaultValue: number | string | boolean;
  /** Optional brief description shown in the inspector tooltip. */
  readonly description?: string;
  /** For `enum` kind: the closed set of allowed values. */
  readonly choices?: readonly string[];
  /** For `int` / `float`: clamp range applied in the inspector. */
  readonly min?: number;
  readonly max?: number;
  /**
   * UI grouping hint (per ADR-0033). Properties with no `group` go in
   * the component's primary (always-visible) group. Properties with a
   * `group` join the named secondary section, which the inspector may
   * collapse by default. The group id must appear in the parent
   * ComponentSpec's `propertyGroups`.
   *
   * Purely a UX hint — does not affect codegen, validation, or
   * persistence.
   */
  readonly group?: string;
  /**
   * Divisibility hint for inline inspector guidance (per ADR-0033).
   * When set, the inspector knows this property's value must divide
   * the named property's value evenly. The control offers valid
   * divisors prominently rather than letting the user enter an
   * invalid value and seeing a deterministic error after the fact.
   *
   * Example: on MultiHeadAttention, `num_heads` has `divides:
   * 'embed_dim'` because head_dim = embed_dim / num_heads must be an
   * integer. On GroupedQueryAttention, `num_kv_heads` has `divides:
   * 'num_heads'`.
   *
   * The validator in `validation/index.ts` independently enforces
   * divisibility — this is anticipation, not detection, and does NOT
   * replace deterministic checking.
   */
  readonly divides?: string;
}

/**
 * Property group metadata. Components with substantial property
 * surfaces (attention variants, MoEFFN, GatedFFN) define groups so
 * the inspector renders sections matching the user's mental model
 * rather than a flat wall of fields. Per ADR-0033.
 */
export interface PropertyGroup {
  /** Stable id referenced from PropertySpec.group. */
  readonly id: string;
  /** Human-readable section header. */
  readonly label: string;
  /** Optional short description shown under the section header. */
  readonly description?: string;
  /**
   * When true, the inspector renders this section collapsed by
   * default. The inspector still auto-expands when any property in
   * the group has a non-default value (signal of demonstrated user
   * interest). Defaults to false (open).
   */
  readonly defaultCollapsed?: boolean;
}

export const PropertySpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(64),
  kind: PropertyKindSchema,
  defaultValue: z.union([z.number(), z.string(), z.boolean()]),
  description: z.string().max(256).optional(),
  choices: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  group: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  divides: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
});

/**
 * One I/O port on a component. Inputs accept incoming edges; outputs
 * produce them. A port's `signature` describes the tensor flowing
 * through it; signatures can depend on the component's property
 * values (e.g. Embedding's output shape depends on `embed_dim`), so
 * the signature is a FUNCTION of resolved properties, not a fixed
 * literal.
 */
export interface PortSpec {
  /** Stable identifier referenced from edges. */
  readonly id: string;
  /** Human-readable label shown next to the port. */
  readonly label: string;
  /**
   * Resolve this port's tensor signature given the current property
   * values. The function is pure; it can use `props` but must not
   * cause side effects (codegen relies on this property).
   */
  readonly signature: (props: ResolvedProperties) => TensorSignature;
}

/**
 * Resolved property values — what the canvas passes to `signature()`
 * and to the codegen hook after the user has set them on the node.
 */
export type PropertyValue = number | string | boolean;
export type ResolvedProperties = Record<string, PropertyValue>;

/**
 * Intermediate-representation node emitted by a component's codegen
 * hook. Backends (PyTorch, JAX, etc.) consume this and produce text.
 *
 * The IR is intentionally minimal — a backend gets the component id,
 * the resolved properties, and a backend-specific extension slot. The
 * backend decides how to render imports, the module init line, and
 * the forward call. The component author writes that backend-specific
 * logic in the codegen hook.
 *
 * Multiple backends per component are supported. PyTorch is the only
 * one populated in Phase 0 sub-phase E; others come online when their
 * backends land.
 */
export interface CodegenIR {
  /** The component this node instance was produced by. */
  readonly componentId: string;
  /** Properties resolved on this node instance. */
  readonly properties: ResolvedProperties;
  /**
   * Per-backend codegen output. The string is the raw fragment the
   * backend will splice into the generated module. Backends look up
   * their own key (`backends['pytorch']`) and use it.
   */
  readonly backends: Record<string, BackendFragment>;
}

/**
 * One backend's contribution for a single component instance.
 *
 * `imports` are emitted once per backend (deduped at codegen time).
 * `init` is the body of the constructor — the line(s) that
 * instantiate this node's sub-modules.
 * `forward` is the body of `forward()` — the line(s) that consume
 * inputs and produce outputs.
 *
 * The component author writes the fragments. The backend assembles
 * the final module by concatenating + deduping.
 */
export interface BackendFragment {
  readonly imports: readonly string[];
  /**
   * Constructor body fragment. `var` is the variable name the
   * codegen layer chose for this node (e.g. `self.attn_0`).
   */
  readonly init: (var_: string) => string;
  /**
   * Forward body fragment. `var` is the same variable name; `inputs`
   * is a record of input-port-id → upstream-variable-name; `outputs`
   * is a record of output-port-id → variable-name to assign.
   *
   * The return value is one or more statements. Multi-line is fine.
   */
  readonly forward: (
    var_: string,
    inputs: Record<string, string>,
    outputs: Record<string, string>,
  ) => string;
}

/**
 * The component specification. Drop-target metadata for the canvas,
 * I/O signature, configurable properties, and codegen hooks.
 *
 * `category` is a UI-grouping hint (the palette puts components in
 * categories). It is NOT load-bearing; the registry doesn't care.
 *
 * `domain` is the high-level domain this component belongs to. Phase
 * 0 sub-phase E ships `ml`. Phase 3 cross-domain expansion adds
 * others (`eng`, `defense`, `pharma`, etc.) without touching this
 * module — domain definitions just register themselves.
 */
export interface ComponentSpec {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly domain: string;
  readonly description: string;
  readonly inputs: readonly PortSpec[];
  readonly outputs: readonly PortSpec[];
  readonly properties: readonly PropertySpec[];
  /**
   * Optional UI grouping metadata (per ADR-0033). Components with
   * substantial property surfaces define groups so the inspector
   * renders sections matching the user's mental model. Simple
   * components (fewer than 4 properties or no natural grouping) omit
   * this field and the inspector renders a flat list. Group ids
   * referenced from PropertySpec.group MUST appear here.
   */
  readonly propertyGroups?: readonly PropertyGroup[];
  /**
   * Produce the IR for a node instance with these properties. Called
   * by the codegen pipeline; ports are resolved separately via
   * `inputs[i].signature(props)` and `outputs[i].signature(props)`.
   */
  readonly codegen: (props: ResolvedProperties) => CodegenIR;
}

/**
 * Mutable registry — components are added at module load time by
 * the domain bundles. Lookups are by id. Future ADRs may allow
 * runtime user-invented components (Phase 1 free-draw) to register
 * here at runtime; for now the set is closed at boot.
 */
export class ComponentRegistry {
  private readonly specs = new Map<string, ComponentSpec>();

  register(spec: ComponentSpec): void {
    if (this.specs.has(spec.id)) {
      throw new Error(`component already registered: ${spec.id}`);
    }
    this.specs.set(spec.id, spec);
  }

  get(id: string): ComponentSpec | undefined {
    return this.specs.get(id);
  }

  require(id: string): ComponentSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new Error(`unknown component id: ${id}`);
    return spec;
  }

  has(id: string): boolean {
    return this.specs.has(id);
  }

  list(): readonly ComponentSpec[] {
    return Array.from(this.specs.values());
  }

  listByDomain(domain: string): readonly ComponentSpec[] {
    return this.list().filter((s) => s.domain === domain);
  }

  listByCategory(category: string): readonly ComponentSpec[] {
    return this.list().filter((s) => s.category === category);
  }
}

/**
 * The default registry singleton. Domain bundles call `loadXDomain()`
 * to register their components. The web app + codegen pipeline both
 * read from here.
 */
export const defaultRegistry = new ComponentRegistry();
