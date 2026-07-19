// AttentionNode — custom Rete React node renderer for attention components.
//
// Replaces the default rete-react-plugin classic Node for MHA-family
// components. The visual content INSIDE the node is the 3D AttentionViz
// running at compact scale — so the node IS the visualization, not just
// a card representing one.
//
// Pitch Sprint Day 9 — the in-canvas wow moment.
//
// Risk-managed:
//   - Compact viz (~220x150) keeps per-node WebGL context cost down
//   - Sockets use RefSocket from rete-react-plugin (the canonical
//     drag-to-connect surface) so connection behavior is unchanged
//   - Falls back to default Node renderer for non-attention components
//   - Visual sidebar tab still exists for fine-tuning + larger viz
//     (per Day 8 plan + user direction: "the window on the side
//     should be for fine tier modulation")

import { Presets as ReactPresets, type ReactArea2D } from 'rete-react-plugin';
import type { ClassicPreset } from 'rete';
import { AttentionViz } from '../components/three/AttentionViz.js';
import type { ArchitectureNode } from './nodes.js';

const { RefSocket } = ReactPresets.classic;

type Scheme = {
  Node: ArchitectureNode;
  Connection: ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>;
};

interface Props {
  data: ArchitectureNode & {
    width?: number;
    height?: number;
    selected?: boolean;
  };
  emit: (props: ReactArea2D<Scheme>) => void;
}

function extractParams(node: ArchitectureNode) {
  const p = node.properties as Record<string, unknown>;
  const num = (key: string, fallback: number): number => {
    const v = p[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    heads: num('n_heads', num('num_heads', num('heads', 8))),
    dModel: num('d_model', num('hidden_dim', num('dim', 512))),
    seqLen: num('seq_len', num('sequence_length', 8)),
  };
}

export function AttentionNode({ data, emit }: Props) {
  const inputs = Object.entries(data.inputs);
  const outputs = Object.entries(data.outputs);
  const selected = data.selected ?? false;
  // Computed inline (NOT useMemo) so property changes propagate even when
  // Rete passes the same data instance reference across re-renders. The
  // setProperty call mutates `data.properties` in place; useMemo with
  // `[data]` dependency wouldn't recompute since the reference is stable.
  const params = extractParams(data);

  // Width is fixed so the inline viz has stable real estate. Sockets
  // float at the edges per the classic Rete pattern.
  const width = 240;
  const vizHeight = 150;

  return (
    <div
      data-testid="node"
      className={[
        'group relative select-none rounded-lg border bg-panel transition-all',
        // Strong drop-shadow so the node stays anchored against the
        // dark grid background (Day 10 visual-anchoring fix).
        'shadow-[0_10px_30px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4)]',
        selected
          ? 'border-accent shadow-[0_0_0_1px_var(--color-accent),0_12px_36px_rgba(244,114,182,0.25)]'
          : 'border-line hover:border-accent/40',
      ].join(' ')}
      style={{ width: `${width}px` }}
    >
      {/* Header */}
      <div
        data-testid="title"
        className="title border-line bg-panel-2 text-text rounded-t-lg border-b px-3 py-2 text-xs font-semibold"
      >
        <span className="text-accent">▸</span> {data.label}
      </div>

      {/* Inline 3D viz — wrapped in pointer-events:none so the WebGL
          canvas + OrbitControls inside DON'T capture mouse events. Rete
          needs every mousedown/mousemove/mouseup over the node body for
          node-drag, socket-connect, and click-to-select to work. The
          viz auto-spins so the structure still feels alive without
          requiring user interaction. The Modulate sidebar version keeps
          OrbitControls live (it's not inside a Rete node). */}
      <div
        className="relative overflow-hidden"
        style={{ height: `${vizHeight}px`, pointerEvents: 'none' }}
      >
        <AttentionViz
          heads={params.heads}
          dModel={params.dModel}
          seqLen={params.seqLen}
          className="h-full w-full"
        />
      </div>

      {/* Sockets row — inputs left, outputs right.
          Class names mirror the default Rete preset so CSS in styles.css
          (.canvas-grid .socket) styles them consistently with non-MHA
          nodes. */}
      <div className="border-line flex items-center justify-between border-t px-1 py-2">
        <div className="flex flex-col gap-1">
          {inputs.map(([key, input]) =>
            input ? (
              <div
                key={key}
                data-testid={`input-${key}`}
                className="input flex items-center gap-1.5"
              >
                <RefSocket
                  name="input-socket"
                  side="input"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={input.socket}
                />
                <span className="text-dim text-[10px]">{input.label}</span>
              </div>
            ) : null,
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          {outputs.map(([key, output]) =>
            output ? (
              <div
                key={key}
                data-testid={`output-${key}`}
                className="output flex items-center gap-1.5"
              >
                <span className="text-dim text-[10px]">{output.label}</span>
                <RefSocket
                  name="output-socket"
                  side="output"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={output.socket}
                />
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
