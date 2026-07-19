// PatchHeatmap — the SEEING layer for activation patching.
//
// The iconic activation-patching plot: rows = layers, columns = token
// positions, each cell shaded by how much patching the clean activation in
// at that (layer, position) restored the clean answer. Bright = the
// answer-distinguishing information flows through here. The hottest cell is
// ringed. Because both prompts share the attention sink and early cascade,
// those cancel — what's left is the real mechanism.

import type { PatchResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: PatchResponse;
};

function short(token: string): string {
  const t = token.replace(/\s+/g, '·');
  return t.length > 6 ? t.slice(0, 6) + '…' : t;
}

export function PatchHeatmap({ data }: Props) {
  const {
    tokens,
    grid,
    seq_len,
    answer,
    corrupted_answer,
    clean_logit_diff,
    corrupted_logit_diff,
  } = data;
  const max = Math.max(...grid.flat().map((v) => Math.abs(v)), 1e-9);

  let best = { layer: 0, pos: 0, v: 0 };
  grid.forEach((row, layer) =>
    row.forEach((v, pos) => {
      if (Math.abs(v) > Math.abs(best.v)) best = { layer, pos, v };
    }),
  );

  const gridCols = `minmax(34px, auto) repeat(${seq_len}, minmax(16px, 1fr))`;

  return (
    <div className="overflow-auto">
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Restored most at{' '}
        <span className="text-accent-warm">
          layer {best.layer}, “{tokens[best.pos]?.trim()}”
        </span>{' '}
        — that&rsquo;s where the “{answer.trim()}” vs “{corrupted_answer.trim()}” information lives.
        Logit-diff: clean <span className="text-text font-mono">{clean_logit_diff.toFixed(1)}</span>{' '}
        → corrupted <span className="text-text font-mono">{corrupted_logit_diff.toFixed(1)}</span>.
      </p>

      <div className="inline-grid gap-px" style={{ gridTemplateColumns: gridCols }}>
        {/* header row: layer-gutter corner + token labels */}
        <div className="bg-panel sticky left-0 top-0 z-10" />
        {tokens.map((tok, p) => (
          <div
            key={`col-${p}`}
            title={tok}
            className="text-dim flex items-end justify-center pb-1 font-mono text-[9px]"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 40 }}
          >
            {short(tok)}
          </div>
        ))}

        {/* body: layer label + cells */}
        {grid.map((row, layer) => (
          <Row key={`row-${layer}`} layer={layer} row={row} tokens={tokens} max={max} best={best} />
        ))}
      </div>

      <div className="text-dim mt-2 flex items-center gap-2 px-1 text-[9px] uppercase tracking-[0.15em]">
        <span>rows = layers</span>
        <span className="bg-line h-2.5 w-px" />
        <span>cols = token position</span>
        <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
          <span
            className="inline-block h-2 w-8 rounded-sm"
            style={{ background: 'linear-gradient(90deg, transparent, rgb(244,114,182))' }}
          />
          restores answer →
        </span>
      </div>
    </div>
  );
}

function Row({
  layer,
  row,
  tokens,
  max,
  best,
}: {
  layer: number;
  row: number[];
  tokens: string[];
  max: number;
  best: { layer: number; pos: number };
}) {
  return (
    <>
      <div className="text-dim bg-panel sticky left-0 flex items-center justify-end pr-2 font-mono text-[9px]">
        L{layer}
      </div>
      {row.map((v, pos) => {
        const intensity = Math.max(0, Math.min(1.2, v / max));
        const isBest = best.layer === layer && best.pos === pos;
        return (
          <div
            key={`cell-${layer}-${pos}`}
            title={`layer ${layer}, "${tokens[pos]?.trim()}": ${v.toFixed(3)}`}
            className={[
              'min-h-[16px] border border-black/20',
              isBest ? 'ring-accent-warm ring-1' : '',
            ].join(' ')}
            style={{ background: `rgba(244, 114, 182, ${intensity.toFixed(3)})` }}
          />
        );
      })}
    </>
  );
}
