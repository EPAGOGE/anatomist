// Structural graph types used by the validator. Re-exported through
// the package index as `@epagoge/components` types.
//
// The canonical home of GraphSpec is `@epagoge/codegen` (it's coupled
// to the code-generation pipeline). The validator needs the SHAPE of
// a graph to walk it, but importing from codegen would invert layering
// (validation must be available to components-domain consumers who
// don't depend on codegen). We re-declare a structural subset here
// that matches the codegen schema; a runtime conversion is unnecessary
// because both schemas are pure data.
//
// If the codegen schema gains a field, this file gains it too (the
// types compose so a codegen-shaped value flows through here without
// further casting).

export interface GraphNode {
  readonly id: string;
  readonly componentId: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: { readonly nodeId: string; readonly portId: string };
  readonly target: { readonly nodeId: string; readonly portId: string };
}

export interface GraphSpec {
  readonly version: 1;
  readonly name: string;
  readonly description?: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}
