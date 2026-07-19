// NeuronList — the SEEING layer for neuron firings (Features).
//
// A ranked list of the strongest neuron-on-token firings: which MLP neuron
// responded hardest, and on which word. The first Features probe — the
// classical, pre-SAE view of "what does a unit respond to." Read it with
// superposition in mind: a big firing is a lead, not a label.

import type { NeuronFiring } from '../../api/mi-endpoints.js';

type Props = {
  firings: NeuronFiring[];
  layer: number;
  dMlp: number;
};

export function NeuronList({ firings, layer, dMlp }: Props) {
  const max = Math.max(...firings.map((f) => Math.abs(f.activation)), 1e-9);

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Strongest firings among <span className="text-text font-mono">{dMlp.toLocaleString()}</span>{' '}
        neurons in layer <span className="text-text font-mono">{layer}</span>&rsquo;s MLP — the
        neuron, the word it fired on, and how hard.
      </p>
      <div className="flex flex-col gap-1">
        {firings.map((f, i) => {
          const pct = Math.max(3, (Math.abs(f.activation) / max) * 100);
          return (
            <div key={i} className="flex items-center gap-1.5 text-[10px]">
              <span className="text-text w-12 shrink-0 font-mono">N{f.neuron}</span>
              <span className="text-dim w-16 shrink-0 truncate font-mono" title={f.token}>
                {f.token.replace(/\s/g, '·') || '∅'}
              </span>
              <div className="bg-panel-2 relative h-2 flex-1 overflow-hidden rounded">
                <div
                  className="bg-accent-soft/70 absolute inset-y-0 left-0 rounded"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-dim w-9 shrink-0 text-right font-mono tabular-nums">
                {f.activation.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
