// Deterministic architecture validation — Phase 0 sub-phase E, E5.
//
// Per ADR-0032 the validation system is TWO-TIER:
//
//   Tier 1 (this module): deterministic validation that DECIDES whether
//   the architecture is valid. Runs AI-free per the reliability-path
//   discipline (ADR-0008). The output is a list of categorized errors
//   that the canvas surfaces as ghost lines and the validation panel
//   lists. This tier is the source of truth for validity.
//
//   Tier 2 (apps/api/src/canvas/explain-error.ts + apps/web ValidationPanel):
//   AI-assisted explanation that helps the user UNDERSTAND a deterministic
//   error. Uses the production-discipline substrate (ADR-0026). The
//   AI does NOT decide whether the architecture is valid — it only
//   explains what tier 1 already determined.
//
// The boundary matters. Architecture validity decisions stay on the
// deterministic reliability path. AI assists by making errors more
// approachable, but if tier 1 says invalid, the architecture is
// invalid regardless of what the AI says.

import type { GraphSpec, GraphNode, GraphEdge } from './graph-types.js';
import type { ComponentRegistry, ComponentSpec, PortSpec } from '../registry/index.js';
import { isCompatible, formatSignature } from '../tensor/index.js';

/**
 * Error categories. Each carries enough context to render a deterministic
 * description AND to ground an AI explanation prompt.
 *
 * `code` is the cache key seed — together with the involved component
 * ids and the conflicting values it forms a stable error fingerprint
 * so the same error pattern produces a cached AI explanation rather
 * than fresh inference.
 */
export type ValidationError =
  | ShapeMismatchError
  | DtypeMismatchError
  | DivisibilityError
  | UnconnectedPortError
  | CyclicGraphError
  | UnreachableNodeError
  | UnknownComponentError;

export interface ShapeMismatchError {
  readonly code: 'shape-mismatch';
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly sourcePortId: string;
  readonly targetNodeId: string;
  readonly targetPortId: string;
  readonly sourceSignature: string; // formatted, e.g. "Tensor[batch,seq,128]:float32"
  readonly targetSignature: string;
  readonly reason: string; // from isCompatible: "dim 1: 128 vs 256"
}

export interface DtypeMismatchError {
  readonly code: 'dtype-mismatch';
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly sourceDtype: string;
  readonly targetDtype: string;
}

/**
 * Property-level constraint violation. The canonical example is
 * MHA/MQA/GQA's `embed_dim % num_heads === 0`. The validator
 * recognizes the well-known transformer divisibility constraints
 * because they're the highest-frequency authoring error and the
 * AI explanation for them is highly actionable ("try num_heads=16
 * which divides 1024 evenly").
 */
export interface DivisibilityError {
  readonly code: 'divisibility';
  readonly nodeId: string;
  readonly componentId: string;
  readonly numerator: { name: string; value: number };
  readonly denominator: { name: string; value: number };
  readonly remainder: number;
  /** Suggested values for the denominator that divide the numerator. */
  readonly suggestions: readonly number[];
}

export interface UnconnectedPortError {
  readonly code: 'unconnected-port';
  readonly nodeId: string;
  readonly componentId: string;
  readonly portId: string;
  readonly portLabel: string;
}

export interface CyclicGraphError {
  readonly code: 'cyclic-graph';
  /** Node ids participating in the cycle (or any node we couldn't order). */
  readonly involvedNodeIds: readonly string[];
}

export interface UnreachableNodeError {
  readonly code: 'unreachable-node';
  readonly nodeId: string;
  readonly componentId: string;
  /**
   * Why: 'no-input' (no Input upstream of this node) or
   * 'no-output' (no Output downstream of this node). The codegen
   * pipeline needs at least one Input and one Output reachable
   * to/from every component.
   */
  readonly reachability: 'no-input' | 'no-output';
}

export interface UnknownComponentError {
  readonly code: 'unknown-component';
  readonly nodeId: string;
  readonly componentId: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

/**
 * Validate a graph against a registry. Returns all errors found
 * (does not short-circuit), so the validation panel can surface
 * everything the user needs to fix.
 */
export function validateGraph(graph: GraphSpec, registry: ComponentRegistry): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Every node must reference a registered component.
  const nodeSpecs = new Map<string, ComponentSpec>();
  for (const node of graph.nodes) {
    const spec = registry.get(node.componentId);
    if (!spec) {
      errors.push({
        code: 'unknown-component',
        nodeId: node.id,
        componentId: node.componentId,
      });
      continue;
    }
    nodeSpecs.set(node.id, spec);
  }

  // 2. Required input ports must have an incoming edge.
  //    "Required" here means every input port — there's no optional
  //    port concept in Phase 0 sub-phase E. If a future spec adds
  //    optional ports the check gains an `optional?: boolean` field.
  for (const node of graph.nodes) {
    const spec = nodeSpecs.get(node.id);
    if (!spec) continue;
    for (const port of spec.inputs) {
      const incoming = graph.edges.filter(
        (e) => e.target.nodeId === node.id && e.target.portId === port.id,
      );
      if (incoming.length === 0) {
        errors.push({
          code: 'unconnected-port',
          nodeId: node.id,
          componentId: node.componentId,
          portId: port.id,
          portLabel: port.label,
        });
      }
    }
  }

  // 3. Edge signature compatibility — shape + dtype.
  for (const edge of graph.edges) {
    const fromSpec = nodeSpecs.get(edge.source.nodeId);
    const toSpec = nodeSpecs.get(edge.target.nodeId);
    if (!fromSpec || !toSpec) continue; // already flagged as unknown-component
    const fromPort = fromSpec.outputs.find((p) => p.id === edge.source.portId);
    const toPort = toSpec.inputs.find((p) => p.id === edge.target.portId);
    if (!fromPort || !toPort) continue; // graph-level integrity error, not validation
    const fromNode = graph.nodes.find((n) => n.id === edge.source.nodeId)!;
    const toNode = graph.nodes.find((n) => n.id === edge.target.nodeId)!;
    const sourceSig = resolvePortSig(fromPort, fromNode);
    const targetSig = resolvePortSig(toPort, toNode);
    if (!sourceSig || !targetSig) continue;
    const reason = isCompatible(sourceSig, targetSig);
    if (reason !== null) {
      if (reason.startsWith('dtype')) {
        errors.push({
          code: 'dtype-mismatch',
          edgeId: edge.id,
          sourceNodeId: edge.source.nodeId,
          targetNodeId: edge.target.nodeId,
          sourceDtype: sourceSig.dtype,
          targetDtype: targetSig.dtype,
        });
      } else {
        errors.push({
          code: 'shape-mismatch',
          edgeId: edge.id,
          sourceNodeId: edge.source.nodeId,
          sourcePortId: edge.source.portId,
          targetNodeId: edge.target.nodeId,
          targetPortId: edge.target.portId,
          sourceSignature: formatSignature(sourceSig),
          targetSignature: formatSignature(targetSig),
          reason,
        });
      }
    }
  }

  // 4. Well-known divisibility constraints on transformer components.
  //    Catalog of (component, numerator-prop, denominator-prop) pairs
  //    that emit cleaner code if they divide evenly.
  for (const node of graph.nodes) {
    const spec = nodeSpecs.get(node.id);
    if (!spec) continue;
    for (const check of DIVISIBILITY_CHECKS) {
      if (!check.componentIds.includes(spec.id)) continue;
      const num = resolveNumber(node, check.numerator);
      const den = resolveNumber(node, check.denominator);
      if (num === null || den === null || den === 0) continue;
      const rem = num % den;
      if (rem !== 0) {
        errors.push({
          code: 'divisibility',
          nodeId: node.id,
          componentId: spec.id,
          numerator: { name: check.numerator, value: num },
          denominator: { name: check.denominator, value: den },
          remainder: rem,
          suggestions: suggestDivisors(num),
        });
      }
    }
  }

  // 5. Cycle detection + unreachable-node detection.
  //    We don't run @epagoge/codegen's topologicalSort directly
  //    because the validator can't depend on codegen (would invert
  //    layering). Inline a cycle check via DFS.
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node.id, []);
  for (const edge of graph.edges) {
    adjacency.get(edge.source.nodeId)?.push(edge.target.nodeId);
  }
  const cycleNodes = findCycleNodes(graph.nodes, adjacency);
  if (cycleNodes.length > 0) {
    errors.push({ code: 'cyclic-graph', involvedNodeIds: cycleNodes });
  }

  // Reachability: every node must have a path from an Input AND
  // a path to an Output (or be one itself). Skip when there are
  // no Inputs/Outputs yet — empty graphs are "not yet valid" but
  // we don't carpet-bomb the panel with reachability errors before
  // the user has dropped anything.
  const inputIds = graph.nodes.filter((n) => isInput(n, registry)).map((n) => n.id);
  const outputIds = graph.nodes.filter((n) => isOutput(n, registry)).map((n) => n.id);
  if (inputIds.length > 0 && outputIds.length > 0) {
    const reachableFromInputs = bfsFrom(inputIds, adjacency);
    const reverseAdj = reverseAdjacency(graph.nodes, graph.edges);
    const reachableToOutputs = bfsFrom(outputIds, reverseAdj);
    for (const node of graph.nodes) {
      if (!reachableFromInputs.has(node.id)) {
        errors.push({
          code: 'unreachable-node',
          nodeId: node.id,
          componentId: node.componentId,
          reachability: 'no-input',
        });
      } else if (!reachableToOutputs.has(node.id)) {
        errors.push({
          code: 'unreachable-node',
          nodeId: node.id,
          componentId: node.componentId,
          reachability: 'no-output',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Produce a stable short fingerprint of an error so identical error
 * patterns reuse cached AI explanations. The fingerprint omits node
 * ids (which are runtime-assigned) but includes the structural
 * details that an explanation actually depends on.
 */
export function errorFingerprint(err: ValidationError): string {
  switch (err.code) {
    case 'shape-mismatch':
      return [
        'shape',
        err.sourceSignature,
        err.targetSignature,
        err.reason.replace(/\s+/g, '_'),
      ].join('|');
    case 'dtype-mismatch':
      return ['dtype', err.sourceDtype, err.targetDtype].join('|');
    case 'divisibility':
      return [
        'div',
        err.componentId,
        err.numerator.name,
        err.numerator.value,
        err.denominator.name,
        err.denominator.value,
      ].join('|');
    case 'unconnected-port':
      return ['unconn', err.componentId, err.portId].join('|');
    case 'cyclic-graph':
      return 'cycle';
    case 'unreachable-node':
      return ['unreach', err.componentId, err.reachability].join('|');
    case 'unknown-component':
      return ['unknown', err.componentId].join('|');
  }
}

/** Compact one-line description for the panel. */
export function formatError(err: ValidationError): string {
  switch (err.code) {
    case 'shape-mismatch':
      return `Shape mismatch on edge ${err.edgeId}: ${err.sourceSignature} → ${err.targetSignature} (${err.reason})`;
    case 'dtype-mismatch':
      return `Dtype mismatch on edge ${err.edgeId}: ${err.sourceDtype} cannot flow into ${err.targetDtype}`;
    case 'divisibility':
      return `${err.componentId}: ${err.numerator.name}=${err.numerator.value} not divisible by ${err.denominator.name}=${err.denominator.value} (remainder ${err.remainder})`;
    case 'unconnected-port':
      return `${err.componentId}: input port "${err.portLabel}" is unconnected`;
    case 'cyclic-graph':
      return `Graph has a cycle involving ${err.involvedNodeIds.length} node(s); architectures must be acyclic`;
    case 'unreachable-node':
      return err.reachability === 'no-input'
        ? `${err.componentId} (node ${err.nodeId}) has no upstream Input node`
        : `${err.componentId} (node ${err.nodeId}) has no downstream Output node`;
    case 'unknown-component':
      return `Unknown component "${err.componentId}" on node ${err.nodeId}`;
  }
}

/**
 * Validate a proposed new edge against an existing graph.
 *
 * The two-tier discipline (ADR-0032) holds: this is the SAME engine
 * that the validation panel uses, surfaced at connection time. We
 * construct the hypothetical graph (existing graph + the new edge),
 * run the full validator, and return the subset of errors that the
 * new edge introduces. If null, the edge is safe to add.
 *
 * Why use the full validator rather than a narrow shape-only check:
 * E5's catalog is the canonical authority on what's invalid, and a
 * connection-time check that only ran shape/dtype would miss e.g. a
 * future check that two specific component pairs are mutually
 * exclusive. Same engine, earlier surface — load-bearing per ADR-0034.
 *
 * Returns `null` when the proposed edge is fine, or an array of
 * NEW errors the edge would introduce (already present in the graph
 * but not caused by this edge are filtered out).
 */
export function validateProposedEdge(
  graph: GraphSpec,
  registry: ComponentRegistry,
  proposed: {
    readonly sourceNodeId: string;
    readonly sourcePortId: string;
    readonly targetNodeId: string;
    readonly targetPortId: string;
  },
): readonly ValidationError[] | null {
  // Snapshot the existing errors. We'll subtract these from the
  // post-hypothesis errors so the caller only sees what the new
  // edge contributes.
  const before = validateGraph(graph, registry);
  const beforeKeys = new Set(before.errors.map(errorKey));

  // Construct the hypothetical graph with the new edge appended.
  const newEdge = {
    id: `__proposed__:${proposed.sourceNodeId}.${proposed.sourcePortId}->${proposed.targetNodeId}.${proposed.targetPortId}`,
    source: { nodeId: proposed.sourceNodeId, portId: proposed.sourcePortId },
    target: { nodeId: proposed.targetNodeId, portId: proposed.targetPortId },
  };
  const hypothetical: GraphSpec = {
    ...graph,
    edges: [...graph.edges, newEdge],
  };

  const after = validateGraph(hypothetical, registry);
  // New errors are those not in the before-set, ignoring `unconnected-port`
  // errors that were resolved by the new edge (the new edge can ONLY add
  // errors or resolve unconnected-port for its target; it never adds an
  // unconnected-port).
  const newErrors = after.errors.filter((e) => !beforeKeys.has(errorKey(e)));
  return newErrors.length === 0 ? null : newErrors;
}

/**
 * Stable identity for error de-duplication. Two errors with the same
 * key are considered the same error. Different from `errorFingerprint`
 * which is for cache lookup — this includes the node/edge ids so we
 * can tell whether a specific error pre-existed or is newly introduced.
 */
function errorKey(err: ValidationError): string {
  switch (err.code) {
    case 'shape-mismatch':
    case 'dtype-mismatch':
      return `${err.code}|${err.edgeId}`;
    case 'divisibility':
      return `${err.code}|${err.nodeId}|${err.numerator.name}|${err.denominator.name}`;
    case 'unconnected-port':
      return `${err.code}|${err.nodeId}|${err.portId}`;
    case 'cyclic-graph':
      return `${err.code}|${err.involvedNodeIds.slice().sort().join(',')}`;
    case 'unreachable-node':
      return `${err.code}|${err.nodeId}|${err.reachability}`;
    case 'unknown-component':
      return `${err.code}|${err.nodeId}`;
  }
}

// ---------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------

interface DivisibilityCheck {
  readonly componentIds: readonly string[];
  readonly numerator: string;
  readonly denominator: string;
}

/**
 * Well-known divisibility constraints recognized at validation time.
 * The list is conservative — only checks that have a known well-defined
 * recovery suggestion ("change denominator to something that divides"
 * is always meaningful). Additional checks land here as the catalog
 * expands.
 */
const DIVISIBILITY_CHECKS: readonly DivisibilityCheck[] = [
  // embed_dim must be divisible by num_heads on multi-head attention
  // variants. Head dim = embed_dim / num_heads must be an integer.
  {
    componentIds: [
      'ml.multi_head_attention',
      'ml.multi_query_attention',
      'ml.grouped_query_attention',
      'ml.flash_attention',
      'ml.sliding_window_attention',
      'ml.cross_attention',
    ],
    numerator: 'embed_dim',
    denominator: 'num_heads',
  },
  // GQA: num_heads must be divisible by num_kv_heads (groups of heads
  // share KV). This is the second-most-common transformer authoring
  // gotcha.
  {
    componentIds: ['ml.grouped_query_attention'],
    numerator: 'num_heads',
    denominator: 'num_kv_heads',
  },
];

function resolveNumber(node: GraphNode, propId: string): number | null {
  const v = node.properties[propId];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  return null;
}

/**
 * Suggest up to four divisors of `n` near common transformer values.
 * Picks divisors in the range that the user is likely to want
 * (between 1 and n, prioritizing powers of two and small primes).
 */
function suggestDivisors(n: number): readonly number[] {
  if (!Number.isFinite(n) || n < 1) return [];
  const all: number[] = [];
  for (let d = 1; d <= n; d++) {
    if (n % d === 0) all.push(d);
  }
  // Prefer common transformer head counts.
  const priority = [8, 16, 12, 4, 32, 24, 64, 2, 6, 48];
  const ranked = all.slice().sort((a, b) => {
    const pa = priority.indexOf(a);
    const pb = priority.indexOf(b);
    if (pa !== -1 && pb !== -1) return pa - pb;
    if (pa !== -1) return -1;
    if (pb !== -1) return 1;
    return a - b;
  });
  return ranked.slice(0, 4);
}

/** Run a port's signature resolver against a node's properties. Returns
 *  null when the resolver throws (defensive — should not happen with
 *  well-typed specs but defends against runtime drift). */
function resolvePortSig(port: PortSpec, node: GraphNode): ReturnType<PortSpec['signature']> | null {
  try {
    return port.signature(node.properties);
  } catch {
    return null;
  }
}

function isInput(node: GraphNode, registry: ComponentRegistry): boolean {
  const spec = registry.get(node.componentId);
  return spec?.inputs.length === 0 && spec?.outputs.length > 0;
}

function isOutput(node: GraphNode, registry: ComponentRegistry): boolean {
  const spec = registry.get(node.componentId);
  return spec?.outputs.length === 0 && spec?.inputs.length > 0;
}

function findCycleNodes(nodes: readonly GraphNode[], adjacency: Map<string, string[]>): string[] {
  // Tarjan-style strongly connected component detection.
  // We only need to know IF there's a cycle and roughly WHICH nodes
  // participate, so a simpler approach is to detect any SCC of size
  // > 1 OR a self-loop.
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycleNodes = new Set<string>();

  function dfs(id: string): void {
    if (stack.has(id)) {
      cycleNodes.add(id);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    stack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (stack.has(next)) {
        cycleNodes.add(id);
        cycleNodes.add(next);
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }
    stack.delete(id);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) dfs(node.id);
  }
  return Array.from(cycleNodes).sort();
}

function bfsFrom(seedIds: readonly string[], adjacency: Map<string, string[]>): Set<string> {
  const reachable = new Set<string>(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return reachable;
}

function reverseAdjacency(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.target.nodeId)?.push(e.source.nodeId);
  return adj;
}
