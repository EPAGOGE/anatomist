// HeadSweepGrid — the SEEING layer for the head-importance sweep.
//
// A heatmap of every attention head (rows = layers, cols = heads), each cell
// shaded by how much knocking that head out changed the prediction. Bright =
// the head mattered. Beside it, the biggest movers ranked. This is the
// "switch through everything and find the one" experience as a single view:
// you don't hunt coordinates, the grid hands you the hot heads.

import { Fragment } from 'react';
import type { HeadEffect } from '../../api/mi-endpoints.js';

type Props = {
  nLayers: number;
  nHeads: number;
  grid: number[][];
  topMovers: HeadEffect[];
  cleanTopToken: string;
};

export function HeadSweepGrid({ nLayers, nHeads, grid, topMovers, cleanTopToken }: Props) {
  const max = Math.max(...grid.flat(), 1e-9);
  const top = topMovers[0];

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Clean answer:{' '}
        <span className="text-text font-mono">{cleanTopToken.replace(/\s/g, '·') || '∅'}</span>.
        Each cell is one head — brighter means knocking it out moved the prediction more.
      </p>

      <div className="flex items-start gap-4">
        {/* Grid — layers numbered down the left, heads numbered across the top,
            so a hot cell reads as a coordinate instead of a counted position. */}
        <div className="shrink-0">
          <div className="text-dim mb-1 text-[9px] uppercase tracking-[0.15em]">
            layer ↓ · head →
          </div>
          <div
            className="inline-grid gap-px"
            style={{ gridTemplateColumns: `1.1rem repeat(${nHeads}, 14px)` }}
          >
            {/* corner + head-number header row */}
            <div />
            {Array.from({ length: nHeads }, (_, h) => (
              <div
                key={`h-${h}`}
                className="text-dim flex items-end justify-center pb-0.5 font-mono text-[8px] tabular-nums"
              >
                {h}
              </div>
            ))}
            {/* one row per layer: layer number, then its head cells */}
            {grid.map((row, layer) => (
              <Fragment key={`r-${layer}`}>
                <div className="text-dim flex items-center justify-end pr-1 font-mono text-[8px] tabular-nums">
                  {layer}
                </div>
                {row.map((eff, head) => {
                  const v = Math.max(0.04, eff / max);
                  const isTop = top && top.layer === layer && top.head === head;
                  return (
                    <div
                      key={`${layer}-${head}`}
                      title={`layer ${layer}, head ${head}: ${eff.toFixed(3)}`}
                      className={[
                        'h-[14px] w-[14px] rounded-[2px]',
                        isTop ? 'ring-accent-warm ring-1' : '',
                      ].join(' ')}
                      style={{ background: `rgba(251, 146, 60, ${v.toFixed(3)})` }}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
          <div className="text-dim mt-1.5 text-[9px] uppercase tracking-[0.15em]">
            {nLayers} layers · {nHeads} heads
          </div>
        </div>

        {/* Ranked movers */}
        <div className="min-w-0 flex-1">
          <div className="text-dim mb-1 text-[10px] uppercase tracking-[0.15em]">top movers</div>
          <div className="flex flex-col gap-1">
            {topMovers.slice(0, 8).map((m, i) => {
              const pct = Math.max(3, (m.effect / max) * 100);
              return (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <span className="text-text w-12 shrink-0 font-mono">
                    L{m.layer}·H{m.head}
                  </span>
                  <div className="bg-panel-2 relative h-2 flex-1 overflow-hidden rounded">
                    <div
                      className="bg-accent-warm/70 absolute inset-y-0 left-0 rounded"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-dim w-9 shrink-0 text-right font-mono tabular-nums">
                    {m.effect.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
