// Rete.js v2 editor setup.
//
// One factory that builds the editor, area, connection, and React
// rendering plugins; wires connection-type validation against
// `isCompatible` from @epagoge/components; returns an imperative
// handle the CanvasView mounts and the page orchestrates.

import { NodeEditor } from 'rete';
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { ReactPlugin, Presets as ReactPresets, type ReactArea2D } from 'rete-react-plugin';
import { createRoot } from 'react-dom/client';
import {
  validateProposedEdge,
  formatError,
  type ComponentRegistry,
  type ValidationError,
} from '@epagoge/components';
import { ArchitectureNode, type SchemeConn, type SchemeNode } from './nodes.js';
import { editorToGraphSpec } from './graph-spec.js';
import { createReteCustomNode, CUSTOM_NODE_RULES } from './custom-node.js';

type Scheme = { Node: SchemeNode; Connection: SchemeConn };
type AreaExtra = ReactArea2D<Scheme>;

export interface EditorHandle {
  readonly editor: NodeEditor<Scheme>;
  readonly area: AreaPlugin<Scheme, AreaExtra>;
  readonly selector: ReturnType<typeof AreaExtensions.selector>;
  /** Listen for "anything changed" events. Used by the code preview + dirty tracking. */
  onChange(handler: () => void): () => void;
  /** Set up to listen to selection. Returns the currently-selected node, or null. */
  onSelectionChange(handler: (node: SchemeNode | null) => void): () => void;
  /**
   * Notified when a proposed connection is rejected by the shared
   * validation engine (per ADR-0034). The handler receives the
   * specific validation errors the proposed edge would introduce,
   * so the UI can surface them in-place with the same language as
   * the validation panel.
   */
  onConnectionRejected(handler: (rejection: ConnectionRejection) => void): () => void;
  /** Imperative: add a node from a component id at viewport center. */
  addNodeAtCenter(node: SchemeNode): Promise<void>;
  /** Imperative: add a node at canvas graph coordinates (already
   *  inverted from the area's zoom/pan transform). */
  addNodeAt(node: SchemeNode, graphX: number, graphY: number): Promise<void>;
  /** Translate a screen-space (clientX/Y) point into graph coordinates,
   *  inverting the area's zoom/pan transform. */
  screenToGraph(clientX: number, clientY: number, container: HTMLElement): { x: number; y: number };
  destroy(): void;
}

/**
 * Carried by `onConnectionRejected` so the UI can render a contextual
 * explanation. The `errors` come directly from the shared validation
 * engine — same shape, same language as the panel sees.
 */
export interface ConnectionRejection {
  readonly sourceNodeId: string;
  readonly sourcePortId: string;
  readonly targetNodeId: string;
  readonly targetPortId: string;
  readonly errors: readonly ValidationError[];
  /** One-line summary suitable for an inline toast. */
  readonly summary: string;
}

export async function createEditor(
  container: HTMLElement,
  opts: { registry: ComponentRegistry },
): Promise<EditorHandle> {
  const editor = new NodeEditor<Scheme>();
  const area = new AreaPlugin<Scheme, AreaExtra>(container);
  const connection = new ConnectionPlugin<Scheme, AreaExtra>();
  const render = new ReactPlugin<Scheme, AreaExtra>({ createRoot });

  editor.use(area);
  area.use(connection);
  area.use(render);

  // The classic presets are typed against the looser ClassicPreset.Node
  // base; our ArchitectureNode subclass is structurally compatible at
  // runtime but TypeScript's variance rules can't see through it.
  // Casting through `unknown` is the pattern Rete v2 apps use for this
  // exact mismatch.
  connection.addPreset(
    ConnectionPresets.classic.setup() as unknown as Parameters<typeof connection.addPreset>[0],
  );
  // Per-component-type custom renderers — see custom-node.ts for the
  // visual-vocabulary registry. AttentionNode embeds AttentionViz; the
  // FFN family embeds the tunnel or branching viz. All other component
  // types fall through to the default classic renderer. Sockets in both
  // paths use RefSocket, so drag-to-connect behavior is unchanged.
  //
  // The outer preset `as any` is the same variance fight as
  // ConnectionPresets.classic.setup() above — the preset config types
  // don't see through our SchemeNode subclass. The inner per-rule casts
  // that used to live here are gone: createReteCustomNode contains them.
  const customizedPreset = ReactPresets.classic.setup({
    customize: { node: createReteCustomNode(CUSTOM_NODE_RULES) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  render.addPreset(customizedPreset as unknown as Parameters<typeof render.addPreset>[0]);

  AreaExtensions.simpleNodesOrder(area);
  const selector = AreaExtensions.selector();
  AreaExtensions.selectableNodes(area, selector, {
    accumulating: AreaExtensions.accumulateOnCtrl(),
  });

  // Connection-time validation (per ADR-0034) reuses the SHARED
  // engine from `@epagoge/components/validation`. The connection
  // pipe constructs the current graph snapshot, asks the engine
  // whether the proposed edge would introduce new errors, and
  // rejects + notifies if so. Same engine, earlier surface as the
  // validation panel — never a parallel checker.
  const rejectionListeners = new Set<(r: ConnectionRejection) => void>();
  editor.addPipe((context) => {
    if (context.type === 'connectioncreate') {
      const { source, sourceOutput, target, targetInput } = context.data;
      const srcNode = editor.getNode(source);
      const tgtNode = editor.getNode(target);
      if (!srcNode || !tgtNode) return context;
      const graph = editorToGraphSpec(editor, { name: '__validate__' });
      const errors = validateProposedEdge(graph, opts.registry, {
        sourceNodeId: source,
        sourcePortId: sourceOutput,
        targetNodeId: target,
        targetPortId: targetInput,
      });
      if (errors !== null && errors.length > 0) {
        const summary = formatError(errors[0]!);
        const rejection: ConnectionRejection = {
          sourceNodeId: source,
          sourcePortId: sourceOutput,
          targetNodeId: target,
          targetPortId: targetInput,
          errors,
          summary,
        };
        for (const fn of rejectionListeners) fn(rejection);
        return; // returning undefined cancels the event
      }
    }
    return context;
  });

  // Notify subscribers when anything that affects the graph changes.
  const changeListeners = new Set<() => void>();
  editor.addPipe((context) => {
    if (
      context.type === 'nodecreated' ||
      context.type === 'noderemoved' ||
      context.type === 'connectioncreated' ||
      context.type === 'connectionremoved'
    ) {
      queueMicrotask(() => {
        for (const fn of changeListeners) fn();
      });
    }
    return context;
  });

  // Selection tracking. Rete's selector fires its own events; we mirror
  // them into a per-page handler.
  const selectionListeners = new Set<(node: SchemeNode | null) => void>();
  area.addPipe((context) => {
    if (context.type === 'nodepicked') {
      const node = editor.getNode(context.data.id);
      for (const fn of selectionListeners) fn(node ?? null);
    }
    return context;
  });

  return {
    editor,
    area,
    selector,
    onChange(handler) {
      changeListeners.add(handler);
      return () => changeListeners.delete(handler);
    },
    onSelectionChange(handler) {
      selectionListeners.add(handler);
      return () => selectionListeners.delete(handler);
    },
    onConnectionRejected(handler) {
      rejectionListeners.add(handler);
      return () => rejectionListeners.delete(handler);
    },
    async addNodeAtCenter(node) {
      await editor.addNode(node);
      // Place near viewport center. AreaPlugin tracks viewport
      // transform; for E1 we just nudge each new node so they don't
      // stack atop each other.
      const offset = 80 + editor.getNodes().length * 24;
      await area.translate(node.id, { x: offset, y: offset });
    },
    async addNodeAt(node, graphX, graphY) {
      await editor.addNode(node);
      await area.translate(node.id, { x: graphX, y: graphY });
    },
    screenToGraph(clientX, clientY, container) {
      const rect = container.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      // Invert the area's pan + zoom transform. AreaPlugin's
      // `area.transform` is { k, x, y } where k = zoom and (x, y) =
      // pan offset in screen pixels.
      const t = area.area.transform;
      return {
        x: (localX - t.x) / t.k,
        y: (localY - t.y) / t.k,
      };
    },
    destroy() {
      changeListeners.clear();
      selectionListeners.clear();
      rejectionListeners.clear();
      area.destroy();
    },
  };
}

export { ArchitectureNode };
