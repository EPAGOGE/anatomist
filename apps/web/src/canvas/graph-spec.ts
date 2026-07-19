// Round-trip helpers between the Rete editor state and the
// canonical GraphSpec we persist on the chain.
//
// to-graph-spec walks the editor's nodes + connections, extracts the
// component id, properties, and edge pairs, returns a GraphSpec ready
// for POST /architectures.
//
// from-graph-spec hydrates the editor from a replayed payload: looks
// up each component in the registry, instantiates ArchitectureNodes,
// adds them + their connections, returns the editor for the caller
// to position via the area plugin.

import type { ComponentRegistry } from '@epagoge/components';
import type { GraphSpec } from '@epagoge/codegen';
import { ClassicPreset, NodeEditor } from 'rete';
import { ArchitectureNode, type SchemeConn, type SchemeNode } from './nodes.js';

/** Shape Rete uses for its scheme tag. */
export type Scheme = { Node: SchemeNode; Connection: SchemeConn };

export function editorToGraphSpec(
  editor: NodeEditor<Scheme>,
  meta: { name: string; description?: string },
): GraphSpec {
  const nodes = editor.getNodes();
  const connections = editor.getConnections();

  return {
    version: 1,
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    nodes: nodes.map((n) => ({
      id: n.id,
      componentId: n.componentId,
      properties: { ...n.properties },
    })),
    edges: connections.map((c) => ({
      id: c.id,
      source: { nodeId: c.source, portId: c.sourceOutput },
      target: { nodeId: c.target, portId: c.targetInput },
    })),
  };
}

export async function hydrateEditorFromGraphSpec(
  editor: NodeEditor<Scheme>,
  spec: GraphSpec,
  registry: ComponentRegistry,
): Promise<Map<string, string>> {
  // We assign Rete the *original* node ids from the spec where possible
  // so subsequent saves preserve lineage. Rete generates ids on Node
  // construction; we override via the constructor's spec.id when we
  // can. For now we just record the mapping and let edges follow.
  const idMap = new Map<string, string>();

  for (const node of spec.nodes) {
    const componentSpec = registry.require(node.componentId);
    const archNode = new ArchitectureNode(componentSpec, node.properties);
    // Rete's classic preset assigns ids in the base Node constructor.
    // For E1 we accept that hydrated graphs get new ids; subsequent
    // saves carry the architecture_id forward but individual node ids
    // may shift. A future tranche can override the id via reflection.
    await editor.addNode(archNode);
    idMap.set(node.id, archNode.id);
  }

  for (const edge of spec.edges) {
    const src = idMap.get(edge.source.nodeId);
    const tgt = idMap.get(edge.target.nodeId);
    if (!src || !tgt) continue;
    const srcNode = editor.getNode(src);
    const tgtNode = editor.getNode(tgt);
    if (!srcNode || !tgtNode) continue;
    // Connection is typed against the loose ClassicPreset.Node base;
    // our ArchitectureNode satisfies the base structurally but the
    // generic constructor parameter wants the exact type.
    const conn = new ClassicPreset.Connection(
      srcNode as unknown as ClassicPreset.Node,
      edge.source.portId,
      tgtNode as unknown as ClassicPreset.Node,
      edge.target.portId,
    );
    await editor.addConnection(conn);
  }

  return idMap;
}
