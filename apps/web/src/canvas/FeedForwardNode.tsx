// FeedForwardNode — custom Rete React node renderer for the FFN family.
//
// Second entry in the visual-vocabulary system after AttentionNode. The
// FFN family has three structural sub-shapes that need different visuals:
//
//   - ml.feedforward + ml.gated_ffn → expansion-contraction tunnel
//       (canonical two-layer FFN, SwiGLU/GeGLU/ReGLU). Both are
//       structurally tunnels — gated FFN adds a gating path but the
//       gross shape is still embed → hidden → embed.
//   - ml.moe_ffn → routed branching
//       (router → N expert columns → recombine). Structurally distinct;
//       the qualitative shape is *parallelism*, not *depth*.
//
// One node component, two viz families dispatched internally. The Rete
// dispatcher in editor.ts only sees one rule for the FFN family; this
// component picks the right scene based on the component variant.
//
// All the cross-Rete-React-boundary discipline AttentionNode established
// applies here verbatim:
//   - Inline 3D body wrapped in pointer-events: none so OrbitControls +
//     WebGL pointer capture don't break node-drag / socket-connect /
//     click-to-select (RETE_BRIDGE per IDEA-481).
//   - Params computed inline (NOT useMemo) so property changes propagate
//     even when Rete passes the same data instance reference across
//     re-renders (RETE_BRIDGE per Day 11 fix in 3d5b768).
//   - Sockets use RefSocket from rete-react-plugin so drag-to-connect
//     behavior matches non-FFN nodes.

import { Presets as ReactPresets, type ReactArea2D } from 'rete-react-plugin';
import type { ClassicPreset } from 'rete';
import { FeedForwardViz } from '../components/three/FeedForwardViz.js';
import { MoEViz } from '../components/three/MoEViz.js';
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
    embedDim: num('embed_dim', num('hidden_dim', 768)),
    hiddenDim: num('hidden_dim', 3072),
    numExperts: num('num_experts', 8),
    topK: num('top_k', 2),
  };
}

function isMoEVariant(componentId: string): boolean {
  return /moe/i.test(componentId);
}

export function FeedForwardNode({ data, emit }: Props) {
  const inputs = Object.entries(data.inputs);
  const outputs = Object.entries(data.outputs);
  const selected = data.selected ?? false;
  // Computed inline (NOT useMemo) — see Day 11 RETE_BRIDGE note.
  const params = extractParams(data);
  const variant = isMoEVariant(data.componentId) ? 'moe' : 'tunnel';

  const width = 240;
  const vizHeight = 150;

  return (
    <div
      data-testid="node"
      className={[
        'group relative select-none rounded-lg border bg-panel transition-all',
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

      {/* Inline 3D viz — pointer-events: none per IDEA-481. */}
      <div
        className="relative overflow-hidden"
        style={{ height: `${vizHeight}px`, pointerEvents: 'none' }}
      >
        {variant === 'moe' ? (
          <MoEViz
            numExperts={params.numExperts}
            topK={params.topK}
            embedDim={params.embedDim}
            className="h-full w-full"
          />
        ) : (
          <FeedForwardViz
            embedDim={params.embedDim}
            hiddenDim={params.hiddenDim}
            className="h-full w-full"
          />
        )}
      </div>

      {/* Sockets row — same shape as AttentionNode so CSS in styles.css
          styles them consistently across both renderers. */}
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
