// SaeFeatureList — the SEEING layer for SAE features (sidecar).
//
// The strongest learned features at the final token, each self-labeled by the
// tokens its decoder direction promotes. This is the un-mixed view the neuron
// probe motivated: instead of polysemantic neurons, a sparse dictionary of
// (mostly) monosemantic features. FVU is the reconstruction canary shown
// honestly; a broken SAE reads as terrible reconstruction, not silent lies.

import type { SaeFeaturesResponse } from '../../api/sae-endpoints.js';

type Props = {
  data: SaeFeaturesResponse;
};

function show(s: string): string {
  return (s ?? '').replace(/ /g, '·') || '∅';
}

export function SaeFeatureList({ data }: Props) {
  const { tokens, position, features, fvu, l0, d_sae } = data;
  const max = Math.max(...features.map((f) => f.activation), 1e-9);
  const healthy = fvu < 0.5;

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Strongest of <span className="text-text font-mono">{d_sae.toLocaleString()}</span> learned
        features at <span className="text-text font-mono">{show(tokens[position] ?? '')}</span>,
        each labeled by the tokens it promotes.{' '}
        <span className={healthy ? '' : 'text-accent-warm'}>
          Reconstruction: FVU {fvu.toFixed(3)}
          {healthy ? '' : ' (poor; treat these features with suspicion)'}
        </span>{' '}
        · ~{l0.toFixed(0)} features active/token.
      </p>
      <div className="flex flex-col gap-1.5">
        {features.map((f) => {
          const pct = Math.max(3, (f.activation / max) * 100);
          return (
            <div key={f.feature} className="flex items-center gap-2 text-[10px]">
              <span className="text-text w-14 shrink-0 font-mono">f{f.feature}</span>
              <div className="bg-panel-2 relative h-2 w-20 shrink-0 overflow-hidden rounded">
                <div
                  className="bg-accent-soft/70 absolute inset-y-0 left-0 rounded"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-dim w-10 shrink-0 text-right font-mono tabular-nums">
                {f.activation.toFixed(1)}
              </span>
              <span className="text-dim min-w-0 truncate font-mono">
                {f.label_tokens.map(show).join('  ')}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-dim mt-2 text-[10px] leading-relaxed">
        To test whether a feature actually matters: note its number, then run “Knock out one learned
        feature” with it.
      </p>
    </div>
  );
}
