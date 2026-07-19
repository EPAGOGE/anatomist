// AttributionHeatmap — the SEEING layer for direct logit attribution.
//
// A DIVERGING heatmap: every attention head (rows = layers, cols = heads) plus
// each layer's MLP, coloured by its SIGNED direct contribution to the answer.
// Warm = pushes toward your target word, cool = pushes toward the other. The
// colour is the meaning, not decoration — it's the sign of the attribution.
// Unlike the ablation sweep, cascade heads that act indirectly read ~0 here.

import { Fragment } from 'react';
import type { AttributionResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: AttributionResponse;
};

// Below this |logit-diff|, the two answer words barely differ for the prompt,
// so the attribution is decomposing near-nothing — almost always a sign the
// contrast pair was left on a default that doesn't match the prompt.
const CONTRAST_FLOOR = 0.75;

/** Warm (orange) for "toward answer", cool (indigo) for "toward corrupted". */
function diverging(v: number, max: number): string {
  const t = Math.max(-1, Math.min(1, v / max));
  const a = (0.06 + 0.94 * Math.abs(t)).toFixed(3);
  return t >= 0 ? `rgba(251, 146, 60, ${a})` : `rgba(129, 140, 248, ${a})`;
}

function label(c: { layer: number; head: number }): string {
  return c.head === -1 ? `L${c.layer}·MLP` : `L${c.layer}·H${c.head}`;
}

export function AttributionHeatmap({ data }: Props) {
  const { n_heads, head_grid, mlp, top_contributors, answer, corrupted_answer, logit_diff } = data;
  const max = Math.max(...head_grid.flat().map(Math.abs), ...mlp.map(Math.abs), 1e-9);

  const gridCols = `1.1rem repeat(${n_heads}, 14px) 7px 20px`;

  return (
    <div className="overflow-auto">
      {Math.abs(logit_diff) < CONTRAST_FLOOR && (
        <div className="border-accent-warm/40 bg-accent-warm/10 text-accent-warm mb-2 rounded border px-2 py-1.5 text-[11px] leading-snug">
          ⚠ “{answer.trim()}” and “{corrupted_answer.trim()}” barely differ for this prompt
          (logit-diff {logit_diff.toFixed(2)}) — you’re likely reading noise, not a real contrast.
          Set the <span className="font-semibold">Answer</span> /{' '}
          <span className="font-semibold">vs.</span> fields to the two words you mean to compare.
        </div>
      )}
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        <span className="text-accent-warm">warm → “{answer.trim()}”</span> ·{' '}
        <span style={{ color: 'rgb(129,140,248)' }}>cool → “{corrupted_answer.trim()}”</span>. Each
        cell is one component&rsquo;s <em>direct</em> push on the output. Final logit-diff:{' '}
        <span className="text-text font-mono">{logit_diff.toFixed(2)}</span>.
      </p>

      <div className="flex items-start gap-4">
        <div className="shrink-0">
          <div className="text-dim mb-1 text-[9px] uppercase tracking-[0.15em]">
            layer ↓ · head → · MLP
          </div>
          <div className="inline-grid gap-px" style={{ gridTemplateColumns: gridCols }}>
            {/* header: corner + head numbers + gap + MLP */}
            <div />
            {Array.from({ length: n_heads }, (_, h) => (
              <div
                key={`h-${h}`}
                className="text-dim flex items-end justify-center pb-0.5 font-mono text-[8px] tabular-nums"
              >
                {h}
              </div>
            ))}
            <div />
            <div className="text-dim flex items-end justify-center pb-0.5 text-[8px]">M</div>

            {/* one row per layer */}
            {head_grid.map((row, layer) => {
              const m = mlp[layer] ?? 0;
              return (
                <Fragment key={`r-${layer}`}>
                  <div className="text-dim flex items-center justify-end pr-1 font-mono text-[8px] tabular-nums">
                    {layer}
                  </div>
                  {row.map((v, head) => (
                    <div
                      key={`${layer}-${head}`}
                      title={`L${layer}·H${head}: ${v >= 0 ? '+' : ''}${v.toFixed(3)}`}
                      className="h-[14px] w-[14px] rounded-[2px]"
                      style={{ background: diverging(v, max) }}
                    />
                  ))}
                  <div />
                  <div
                    title={`L${layer}·MLP: ${m >= 0 ? '+' : ''}${m.toFixed(3)}`}
                    className="h-[14px] w-[18px] rounded-[2px]"
                    style={{ background: diverging(m, max) }}
                  />
                </Fragment>
              );
            })}
          </div>
        </div>

        {/* Ranked signed contributors */}
        <div className="min-w-0 flex-1">
          <div className="text-dim mb-1 text-[10px] uppercase tracking-[0.15em]">
            biggest writers
          </div>
          <div className="flex flex-col gap-1">
            {top_contributors.slice(0, 9).map((c, i) => {
              const pct = Math.max(3, (Math.abs(c.effect) / max) * 100);
              const warm = c.effect >= 0;
              return (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <span className="text-text w-14 shrink-0 font-mono">{label(c)}</span>
                  <div className="bg-panel-2 relative h-2 flex-1 overflow-hidden rounded">
                    <div
                      className="absolute inset-y-0 left-0 rounded"
                      style={{
                        width: `${pct}%`,
                        background: warm ? 'rgba(251,146,60,0.8)' : 'rgba(129,140,248,0.8)',
                      }}
                    />
                  </div>
                  <span className="text-dim w-10 shrink-0 text-right font-mono tabular-nums">
                    {c.effect >= 0 ? '+' : ''}
                    {c.effect.toFixed(2)}
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
