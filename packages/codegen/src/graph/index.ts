// Graph specification — the shape of an architecture composed in the
// canvas. Persisted to the architecture-composition chain as canonical
// CBOR; loaded back to replay any historical composition.
//
// One GraphSpec maps to one nn.Module subclass (or framework equivalent
// once non-PyTorch backends land). The fields here are the minimum
// needed to reproduce the architecture; UI-only state (positions, zoom
// level) lives outside this schema and is NOT signed onto the chain —
// the chain captures STRUCTURE, not LAYOUT.

import { z } from 'zod';

/**
 * A single node instance in the graph. Stable id (canvas-assigned),
 * component type (from the registry), resolved properties.
 *
 * `componentId` must match a registered component at codegen time.
 * Properties are a serialized record of the property values the user
 * set on this node instance.
 */
export const GraphNodeSchema = z.object({
  id: z.string().min(1).max(64),
  componentId: z.string().min(1).max(128),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

/**
 * A directed edge from one node's output port to another's input port.
 * Port ids match the component spec's port definitions.
 */
export const GraphEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  source: z.object({
    nodeId: z.string().min(1),
    portId: z.string().min(1),
  }),
  target: z.object({
    nodeId: z.string().min(1),
    portId: z.string().min(1),
  }),
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/**
 * The composed architecture. Versioned so future schema changes can
 * migrate older saves without breaking replay.
 */
export const GraphSpecSchema = z.object({
  /** Schema version. v1 is the Phase 0 sub-phase E baseline. */
  version: z.literal(1),
  /** Author-chosen name shown in lists. */
  name: z.string().min(1).max(128),
  /** Optional description. */
  description: z.string().max(2048).optional(),
  /** Nodes and edges. Order is canonical (id-sorted) for determinism. */
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

export type GraphSpec = z.infer<typeof GraphSpecSchema>;

/**
 * Topological sort. Returns nodes in dependency order — sources first,
 * sinks last. Throws on cycles (the canvas should prevent these but
 * we defend in depth).
 *
 * Algorithm: Kahn's. O(V + E).
 */
export function topologicalSort(graph: GraphSpec): GraphNode[] {
  // Build adjacency + in-degree maps.
  const nodeById = new Map<string, GraphNode>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    inDegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source.nodeId) || !nodeById.has(edge.target.nodeId)) {
      throw new Error(
        `edge ${edge.id} references unknown node: ${edge.source.nodeId} → ${edge.target.nodeId}`,
      );
    }
    outgoing.get(edge.source.nodeId)!.push(edge.target.nodeId);
    inDegree.set(edge.target.nodeId, (inDegree.get(edge.target.nodeId) ?? 0) + 1);
  }

  // Seed the queue with all zero-in-degree nodes. Sort by id so the
  // output is deterministic when multiple nodes are ready at once.
  const ready: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) ready.push(id);
  }
  ready.sort();

  const ordered: GraphNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const node = nodeById.get(id);
    if (!node) continue;
    ordered.push(node);
    const nexts = (outgoing.get(id) ?? []).slice().sort();
    for (const next of nexts) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) ready.push(next);
    }
    ready.sort();
  }

  if (ordered.length !== graph.nodes.length) {
    const remaining = graph.nodes.length - ordered.length;
    throw new Error(`graph has cycle(s); ${remaining} node(s) not reachable in topo order`);
  }

  return ordered;
}

/**
 * Find every edge that targets a given node's input port.
 */
export function edgesIntoPort(
  graph: GraphSpec,
  nodeId: string,
  portId: string,
): readonly GraphEdge[] {
  return graph.edges.filter((e) => e.target.nodeId === nodeId && e.target.portId === portId);
}

/**
 * Find the edge sourcing a given input port. Returns null if no edge
 * (port is unconnected) or throws if multiple edges target the same
 * input port (which would be a graph-validity error).
 */
export function singleEdgeIntoPort(
  graph: GraphSpec,
  nodeId: string,
  portId: string,
): GraphEdge | null {
  const edges = edgesIntoPort(graph, nodeId, portId);
  if (edges.length === 0) return null;
  if (edges.length > 1) {
    throw new Error(`port ${nodeId}:${portId} has ${edges.length} incoming edges (expected ≤ 1)`);
  }
  return edges[0]!;
}
