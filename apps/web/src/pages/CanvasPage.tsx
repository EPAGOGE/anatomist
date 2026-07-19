// Phase 0 sub-phase E — the visual ML architecture composition canvas.
//
// Three-column layout: palette (left), canvas (middle), inspector +
// code preview (right). Save → POST /architectures emits a signed
// event on the per-user architecture-composition chain. The chain
// ribbon at the bottom of the authenticated shell shows the new
// event land (see components/chain-ribbon/, ADR-0031).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ComponentRegistry,
  loadMlDomain,
  type ComponentSpec,
  type PropertyValue,
} from '@epagoge/components';
import * as Tooltip from '@radix-ui/react-tooltip';
import { CanvasView, type CanvasViewHandle } from '../canvas/CanvasView.js';
import { CompactPalette } from '../canvas/CompactPalette.js';
import { PropertyInspector } from '../canvas/PropertyInspector.js';
import { CodePreview } from '../canvas/CodePreview.js';
import { LoadDialog } from '../canvas/LoadDialog.js';
import { ValidationPanel } from '../canvas/ValidationPanel.js';
import { CanvasChatDock } from '../components/chat/CanvasChatDock.js';
import { Toolchest } from '../probe/Toolchest.js';
import { ProbeResultCard, type ProbeRun } from '../probe/ProbeResultCard.js';
import { AttentionViz } from '../components/three/AttentionViz.js';
import { FeedForwardViz } from '../components/three/FeedForwardViz.js';
import { MoEViz } from '../components/three/MoEViz.js';
import {
  Cube,
  Sliders,
  Code,
  ShieldCheck,
  CaretRight,
  Flask,
  X as CloseIcon,
} from '@phosphor-icons/react';
import { ArchitectureNode } from '../canvas/nodes.js';
import { componentIdHasCustomRenderer, isAttentionLike, isFFNLike } from '../canvas/custom-node.js';
import { editorToGraphSpec, hydrateEditorFromGraphSpec } from '../canvas/graph-spec.js';
import type { EditorHandle } from '../canvas/editor.js';
import { saveArchitecture } from '../api/endpoints.js';
import type { ApiError } from '../api/client.js';
import type { GraphSpec } from '@epagoge/codegen';
import { truncateHash } from '../util/format.js';
import { useProjectStore } from '../projects/store.js';

type RightTab = 'inspector' | 'code' | 'validation' | 'modulate' | 'probe';

/**
 * Whether the canvas draws a custom 3D body for this component type.
 * Derives directly from the custom-node.ts visual-vocabulary registry
 * — the canvas dispatcher and the Modulate sidebar cannot drift apart.
 */
function hasVisualization(componentId: string | undefined): boolean {
  return componentIdHasCustomRenderer(componentId);
}

/**
 * Extract attention-viz params from a selected node's properties.
 * Falls back to sensible defaults when the node doesn't carry a given
 * property under any of the expected names.
 */
function extractAttentionParams(node: ArchitectureNode | null) {
  const p = (node?.properties ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number) => {
    const v = p[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    heads: num('n_heads', num('num_heads', num('heads', 8))),
    dModel: num('d_model', num('hidden_dim', num('dim', 512))),
    seqLen: num('seq_len', num('sequence_length', 8)),
  };
}

/**
 * Extract FFN-family params. Tunnel viz reads embed_dim + hidden_dim;
 * MoE viz reads num_experts + top_k + embed_dim. Same fallback shape as
 * extractAttentionParams.
 */
function extractFFNParams(node: ArchitectureNode | null) {
  const p = (node?.properties ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number) => {
    const v = p[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    embedDim: num('embed_dim', num('hidden_dim', 768)),
    hiddenDim: num('hidden_dim', 3072),
    numExperts: num('num_experts', 8),
    topK: num('top_k', 2),
  };
}

export function CanvasPage() {
  const registry = useMemo(() => {
    const r = new ComponentRegistry();
    loadMlDomain(r);
    return r;
  }, []);

  const handleRef = useRef<EditorHandle | null>(null);
  const viewRef = useRef<CanvasViewHandle | null>(null);
  const queryClient = useQueryClient();

  const [selectedNode, setSelectedNode] = useState<ArchitectureNode | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('inspector');
  // Day 10 — right panel collapses to the 56px icon strip by default;
  // the canvas owns the real estate. Click an icon to expand; click the
  // active icon again to collapse. "the canvas is the art."
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  // Day 11 fix — version counter bumped on every property change so the
  // Inspector + Modulate views re-render to show the new value. We
  // CANNOT do { ...node } to force re-render because spread drops the
  // ArchitectureNode class prototype, so node.setProperty becomes
  // undefined on the NEXT change. The counter approach keeps the real
  // class instance and uses key-remount to force a fresh render.
  const [propVersion, setPropVersion] = useState(0);
  const [archName, setArchName] = useState('Untitled Architecture');
  const [graph, setGraph] = useState<GraphSpec | null>(null);
  const [architectureId, setArchitectureId] = useState<string | null>(null);
  const [lastSavedHash, setLastSavedHash] = useState<string | null>(null);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  // The active MI probe result — when set, a learning-fold card floats on
  // the canvas (Subsystem 3). null = no card showing.
  const [probeRun, setProbeRun] = useState<ProbeRun | null>(null);

  // Per ADR-0035 the canvas→code update is DEBOUNCED — the code
  // catches up shortly after the canvas settles rather than
  // thrashing on every micro-edit. 150ms is the empirically
  // comfortable settle time: short enough that the user perceives
  // it as live (the mirror feel), long enough to coalesce rapid
  // drag/drop or property-change bursts.
  const DEBOUNCE_MS = 150;
  const recomputeTimerRef = useRef<number | null>(null);

  const recomputeGraphNow = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    setGraph(editorToGraphSpec(handle.editor, { name: archName }));
  }, [archName]);

  const recomputeGraph = useCallback(() => {
    if (recomputeTimerRef.current !== null) {
      window.clearTimeout(recomputeTimerRef.current);
    }
    recomputeTimerRef.current = window.setTimeout(() => {
      recomputeTimerRef.current = null;
      recomputeGraphNow();
    }, DEBOUNCE_MS);
  }, [recomputeGraphNow]);

  // Cancel pending recomputes when the page unmounts so we don't
  // setState on a dead component.
  useEffect(() => {
    return () => {
      if (recomputeTimerRef.current !== null) {
        window.clearTimeout(recomputeTimerRef.current);
      }
    };
  }, []);

  // Re-emit on name change so the GraphSpec's name reflects the input.
  // Name changes are debounced like the rest; the code preview shows
  // the new class name after the user stops typing.
  useEffect(() => {
    recomputeGraph();
  }, [archName, recomputeGraph]);

  const onCanvasReady = useCallback(
    (handle: EditorHandle) => {
      handleRef.current = handle;
      recomputeGraphNow();

      // Pitch Sprint Day 8 — pre-seeded demo MHA. When the canvas mounts
      // empty and no load is incoming, auto-add a multi-head-attention
      // node so the demo opens to something instead of a blank canvas.
      // 300ms delay lets an incoming load take precedence (LoadDialog
      // → onLoadArchitecture path fires soon after onCanvasReady when
      // the user navigates to /canvas via a load link).
      window.setTimeout(() => {
        if (handle.editor.getNodes().length > 0) return;
        const mhaSpec = registry
          .list()
          .find((s) => /attention/i.test(s.id) || /multi.?head/i.test(s.name));
        if (!mhaSpec) return;
        const defaults = Object.fromEntries(
          mhaSpec.properties.map((p) => [p.id, p.defaultValue] as const),
        );
        const node = new ArchitectureNode(mhaSpec, defaults);
        void handle.addNodeAtCenter(node).then(() => {
          // Auto-select so the Inspector + Modulate tab populate.
          void handle.area.emit({ type: 'nodepicked', data: { id: node.id } });
          setSelectedNode(node);
          recomputeGraphNow();
        });
      }, 300);
    },
    [recomputeGraphNow, registry],
  );

  const onAddComponent = useCallback(
    async (spec: ComponentSpec) => {
      const handle = handleRef.current;
      if (!handle) return;
      const defaults = Object.fromEntries(
        spec.properties.map((p) => [p.id, p.defaultValue] as const),
      );
      const node = new ArchitectureNode(spec, defaults);
      await handle.addNodeAtCenter(node);
      recomputeGraph();
    },
    [recomputeGraph],
  );

  const onDropComponent = useCallback(
    async (componentId: string, graphX: number, graphY: number) => {
      const handle = handleRef.current;
      if (!handle) return;
      const spec = registry.get(componentId);
      if (!spec) {
        console.warn(`Drop ignored: unknown component ${componentId}`);
        return;
      }
      const defaults = Object.fromEntries(
        spec.properties.map((p) => [p.id, p.defaultValue] as const),
      );
      const node = new ArchitectureNode(spec, defaults);
      await handle.addNodeAt(node, graphX, graphY);
      recomputeGraph();
    },
    [recomputeGraph, registry],
  );

  const onPropertyChange = useCallback(
    (id: string, value: PropertyValue) => {
      const node = selectedNode;
      if (!node) return;
      // Mutate in place — setProperty updates node.properties and
      // calls rebuildSockets() to refresh per-port tensor signatures.
      node.setProperty(id, value);
      // Bump version to force re-render of the panel + viz (the node
      // reference is preserved so its class prototype + methods stay
      // intact for the NEXT setProperty call).
      setPropVersion((v) => v + 1);
      // Re-render the node in Rete to reflect new socket sigs.
      handleRef.current?.area.update('node', node.id);
      recomputeGraph();
    },
    [recomputeGraph, selectedNode],
  );

  const onLoadArchitecture = useCallback(
    async (payload: import('../canvas/LoadDialog.js').LoadDialogResult) => {
      const handle = handleRef.current;
      if (!handle) return;

      // Clear the existing graph. Remove connections first so the
      // editor doesn't fight us when nodes-with-edges go missing.
      for (const c of [...handle.editor.getConnections()]) {
        await handle.editor.removeConnection(c.id);
      }
      for (const n of [...handle.editor.getNodes()]) {
        await handle.editor.removeNode(n.id);
      }

      // Hydrate via the helper in graph-spec.ts. The payload shape
      // matches GraphSpec apart from the version literal which the
      // helper doesn't actually read.
      await hydrateEditorFromGraphSpec(
        handle.editor,
        {
          version: 1,
          name: payload.name,
          ...(payload.description ? { description: payload.description } : {}),
          nodes: payload.nodes,
          edges: payload.edges,
        },
        registry,
      );

      setArchitectureId(payload.architecture_id);
      setArchName(payload.name);
      setSelectedNode(null);
      recomputeGraph();
    },
    [recomputeGraph, registry],
  );

  // Code→canvas direction: when the user clicks a line in the
  // code preview, find that node on the canvas and select it.
  // Per ADR-0035 this is the load-bearing half of bidirectional
  // navigation that makes the code feel like a view of the canvas
  // rather than a separate document.
  const onCodeLineClicked = useCallback((nodeId: string) => {
    const handle = handleRef.current;
    if (!handle) return;
    const node = handle.editor.getNode(nodeId);
    if (!node) return;
    // Selection in Rete is owned by the area's selector; the
    // simpler reliable path (works across Rete v2 versions) is
    // to ask the area to pick the node, which both selects in
    // Rete and fires the page's `nodepicked` listener that
    // updates `selectedNode`.
    void handle.area.emit({ type: 'nodepicked', data: { id: node.id } });
    setSelectedNode(node);
    setRightTab('inspector');
    setRightPanelOpen(true);
  }, []);

  // Active project — saves scope into it. Per F-0 Criterion 1, a
  // canvas save without a project is still allowed (the architecture
  // chain's project_id field is optional for backwards-compat) but
  // the badge in the header indicates whether a project is active.
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!graph) throw new Error('no graph to save');
      const result = await saveArchitecture({
        ...(architectureId ? { architecture_id: architectureId } : {}),
        ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
        name: graph.name,
        ...(graph.description ? { description: graph.description } : {}),
        nodes: graph.nodes,
        edges: graph.edges,
      });
      return result;
    },
    onSuccess: (result) => {
      setArchitectureId(result.architecture_id);
      setLastSavedHash(result.event_hash);
      // Flash the canvas border mint — the chain-signing acknowledgment
      // moment. Pairs with the chain ribbon's sign-pulse on the newly-
      // arrived event. Together: dual confirmation that the signing
      // happened, visible on both the workspace AND the provenance feed.
      viewRef.current?.flashSave();
      void queryClient.invalidateQueries({ queryKey: ['chain-ribbon'] });
      void queryClient.invalidateQueries({ queryKey: ['architectures-list'] });
    },
  });

  // Toggle the right panel: clicking an icon opens its panel; clicking
  // the same icon while open collapses the panel.
  function onTabIconClick(tab: RightTab) {
    if (rightPanelOpen && rightTab === tab) {
      setRightPanelOpen(false);
    } else {
      setRightTab(tab);
      setRightPanelOpen(true);
    }
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="bg-obsidian flex h-full w-full flex-col">
        {/* Compact floating top bar */}
        <header className="border-line bg-panel/85 flex items-center gap-3 border-b px-4 py-2 backdrop-blur-md">
          <input
            type="text"
            value={archName}
            onChange={(e) => setArchName(e.target.value)}
            placeholder="Untitled Architecture"
            className="border-line bg-obsidian text-text focus:border-accent/50 w-72 rounded border px-3 py-1 text-sm font-medium transition-colors focus:outline-none"
          />
          <div className="text-dim text-xs">
            {graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges` : ''}
          </div>
          {lastSavedHash && (
            <div className="text-dim font-mono text-[10px]" title={`Last save: ${lastSavedHash}`}>
              <span className="text-success">✓</span> saved {truncateHash(lastSavedHash)}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLoadDialogOpen(true)}
              className="border-line text-text hover:border-accent/50 rounded border px-3 py-1 text-sm transition-colors"
            >
              Load
            </button>
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !graph || graph.nodes.length === 0}
              className="bg-accent hover:bg-accent/90 shadow-accent/20 rounded px-4 py-1 text-sm font-medium text-black shadow transition-all disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </header>

        <LoadDialog
          open={loadDialogOpen}
          onClose={() => setLoadDialogOpen(false)}
          onLoad={(payload) => void onLoadArchitecture(payload)}
        />

        {saveMutation.error && (
          <div className="border-warn/40 bg-warn/10 text-warn border-b px-4 py-2 text-xs">
            {(saveMutation.error as unknown as ApiError).message ?? 'save failed'}
          </div>
        )}

        {/* Three-column body — palette icon strip, canvas, right panel
            (collapsible). Canvas owns whatever's left. */}
        <div className="relative flex flex-1 overflow-hidden">
          <CompactPalette registry={registry} onAdd={onAddComponent} />

          <main className="relative flex-1 overflow-hidden">
            <CanvasView
              ref={viewRef}
              registry={registry}
              onReady={onCanvasReady}
              onSelectionChange={(n) => {
                setSelectedNode(n);
                // Auto-open Inspector on selection so the user immediately
                // sees what they can change.
                if (n) {
                  setRightTab('inspector');
                  setRightPanelOpen(true);
                }
              }}
              onChange={recomputeGraph}
              onDropComponent={(id, x, y) => void onDropComponent(id, x, y)}
            />
            {/* Bottom-docked command/chat bar — talk to the loaded model
                while composing on the canvas. Overlays the canvas bottom
                edge; one line at rest, transcript floats above when there
                are messages. (Subsystem 4 — see CanvasChatDock.tsx.) */}
            <CanvasChatDock />

            {/* MI probe result — the learning fold (Subsystem 3). Floats on
                the canvas when a toolchest button runs; intent → seeing →
                process → math → code, threaded by shared concepts. */}
            {probeRun && (
              <div className="pointer-events-none absolute inset-x-0 top-4 z-40 flex justify-center px-4">
                <div className="pointer-events-auto">
                  <ProbeResultCard run={probeRun} onClose={() => setProbeRun(null)} />
                </div>
              </div>
            )}
          </main>

          {/* Right panel — slides in/out from the right; icon strip
              stays visible at all times. */}
          {rightPanelOpen && (
            <aside className="border-line bg-panel/85 flex w-80 flex-col border-l backdrop-blur-md">
              <div className="border-line bg-panel flex items-center justify-between border-b px-3 py-2">
                <span className="text-dim text-[10px] uppercase tracking-[0.18em]">
                  {rightTab === 'inspector' && 'Inspector'}
                  {rightTab === 'code' && 'Code'}
                  {rightTab === 'validation' && 'Validate'}
                  {rightTab === 'modulate' && 'Modulate'}
                  {rightTab === 'probe' && 'Probe'}
                </span>
                <button
                  type="button"
                  onClick={() => setRightPanelOpen(false)}
                  aria-label="Collapse panel"
                  className="text-dim hover:bg-panel-2 hover:text-text rounded p-1 transition"
                >
                  <CloseIcon size={12} weight="bold" />
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                {rightTab === 'inspector' && (
                  <PropertyInspector
                    key={`inspector-${selectedNode?.id ?? 'none'}-${propVersion}`}
                    node={selectedNode}
                    onChange={onPropertyChange}
                  />
                )}
                {rightTab === 'code' && (
                  <CodePreview
                    graph={graph}
                    registry={registry}
                    highlightedNodeIds={selectedNode ? [selectedNode.id] : []}
                    onLineClicked={onCodeLineClicked}
                  />
                )}
                {rightTab === 'validation' && <ValidationPanel graph={graph} registry={registry} />}
                {rightTab === 'modulate' && (
                  <ModulateTab
                    key={`modulate-${selectedNode?.id ?? 'none'}-${propVersion}`}
                    node={selectedNode}
                  />
                )}
                {rightTab === 'probe' && <Toolchest onResult={setProbeRun} />}
              </div>
            </aside>
          )}

          {/* Right-side icon strip (always visible) */}
          <aside className="border-line bg-panel/60 flex w-14 shrink-0 flex-col items-center border-l py-2">
            <PanelTabIcon
              icon={Sliders}
              label="Inspector"
              active={rightPanelOpen && rightTab === 'inspector'}
              onClick={() => onTabIconClick('inspector')}
            />
            <PanelTabIcon
              icon={Code}
              label="Code"
              active={rightPanelOpen && rightTab === 'code'}
              onClick={() => onTabIconClick('code')}
            />
            <PanelTabIcon
              icon={ShieldCheck}
              label="Validate"
              active={rightPanelOpen && rightTab === 'validation'}
              onClick={() => onTabIconClick('validation')}
            />
            <PanelTabIcon
              icon={Cube}
              label="Modulate"
              active={rightPanelOpen && rightTab === 'modulate'}
              onClick={() => onTabIconClick('modulate')}
            />
            <PanelTabIcon
              icon={Flask}
              label="Probe"
              active={rightPanelOpen && rightTab === 'probe'}
              onClick={() => onTabIconClick('probe')}
            />
            {rightPanelOpen && (
              <button
                type="button"
                onClick={() => setRightPanelOpen(false)}
                aria-label="Collapse all panels"
                className="text-dim hover:text-text hover:bg-panel-2 mt-2 flex h-10 w-10 items-center justify-center rounded-md transition-colors"
                title="Collapse panel"
              >
                <CaretRight size={14} weight="bold" />
              </button>
            )}
          </aside>
        </div>
      </div>
    </Tooltip.Provider>
  );
}

/**
 * Right-side icon-tab button. Click toggles panel; tooltip names the tab.
 */
function PanelTabIcon({
  icon: IconCmp,
  label,
  active,
  onClick,
}: {
  icon: typeof Sliders;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={`mb-1 flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            active ? 'bg-panel-2 text-accent' : 'text-dim hover:bg-panel-2 hover:text-text'
          }`}
        >
          <IconCmp size={16} weight="duotone" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="left"
          sideOffset={8}
          className="glass text-text z-50 rounded-md px-2 py-1 text-[11px]"
        >
          {label}
          <Tooltip.Arrow className="fill-[var(--color-line)]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Modulate tab body — the fine-tuning side panel for the in-canvas 3D
 * component. Day 9 reframed this from "Visual" (the only 3D surface)
 * to "Modulate" (the fine-tune surface for the 3D node ALREADY LIVING
 * on the canvas, per user direction "the window on the side should be
 * for fine tier modulation or changes of the current 3d base object
 * on the canvas itself").
 *
 * The canvas node IS the live viz now (see AttentionNode.tsx). This
 * sidebar surface shows the same viz at larger scale for inspection +
 * a hint pointing to the Inspector tab for parameter editing.
 */
function ModulateTab({ node }: { node: ArchitectureNode | null }) {
  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Cube size={28} weight="duotone" className="text-dim" />
        <div className="text-text text-sm font-medium">Select a component</div>
        <div className="text-dim text-xs leading-relaxed">
          Click a node on the canvas. If it has a 3D body, this panel shows the larger view + tuning
          hints.
        </div>
      </div>
    );
  }

  if (!hasVisualization(node.componentId)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Cube size={28} weight="duotone" className="text-dim" />
        <div className="text-text text-sm font-medium">No 3D yet</div>
        <div className="text-dim text-xs leading-relaxed">
          {node.spec.name} doesn't have a 3D visualization in this build.
          <br />
          Attention and FFN families have visuals; more component families arrive later.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-line bg-panel flex items-center gap-2 border-b px-3 py-2 text-xs">
        <Cube size={14} weight="duotone" className="text-accent" />
        <span className="text-text">{node.spec.name}</span>
        <span className="text-dim ml-auto text-[10px] uppercase tracking-[0.18em]">
          larger view
        </span>
      </div>
      <div className="canvas-grid flex-1">
        <ModulateTabViz node={node} />
      </div>
      <div className="border-line bg-panel/60 text-dim border-t px-3 py-2 text-[10px] leading-relaxed">
        The viz also lives directly on the canvas node. Switch to{' '}
        <span className="text-text">Inspector</span> to modulate parameters; changes flow live to
        both views.
      </div>
    </div>
  );
}

/**
 * Dispatches the right viz for the selected node's family. Same dispatch
 * predicates the canvas custom-node renderer uses (so the two surfaces
 * cannot drift). MoE is the only sub-discriminator inside the FFN family;
 * inlining the regex test here mirrors FeedForwardNode.tsx so the
 * discriminator lives next to the viz it picks.
 */
function ModulateTabViz({ node }: { node: ArchitectureNode }) {
  if (isAttentionLike(node)) {
    const p = extractAttentionParams(node);
    return (
      <AttentionViz heads={p.heads} dModel={p.dModel} seqLen={p.seqLen} className="h-full w-full" />
    );
  }
  if (isFFNLike(node)) {
    const p = extractFFNParams(node);
    if (/moe/i.test(node.componentId)) {
      return (
        <MoEViz
          numExperts={p.numExperts}
          topK={p.topK}
          embedDim={p.embedDim}
          className="h-full w-full"
        />
      );
    }
    return (
      <FeedForwardViz embedDim={p.embedDim} hiddenDim={p.hiddenDim} className="h-full w-full" />
    );
  }
  // hasVisualization gates entry to this component; this fallthrough is
  // unreachable unless a new matcher lands without a viz alongside it.
  return null;
}
