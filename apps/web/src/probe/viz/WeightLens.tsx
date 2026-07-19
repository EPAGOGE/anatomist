// WeightLens — what a neuron IS, read from weights alone (zero forward passes).
//
// Three columns: the tokens whose embeddings excite it (reads, cosine), and
// the tokens it pushes up / down when it fires (promotes / suppresses, via
// the unembedding). Honest expectation-setting: most neurons read as soup —
// that's superposition in the raw, not a broken probe.

import type { WeightLensResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: WeightLensResponse;
};

function show(s: string): string {
  return s.replace(/ /g, '·').replace(/\n/g, '⏎') || '∅';
}

function Column({ title, items }: { title: string; items: { token: string; logit: number }[] }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-dim mb-1 text-[9px] uppercase tracking-[0.15em]">{title}</div>
      {items.map((t, i) => (
        <div key={i} className="flex items-baseline gap-1.5 font-mono text-[10px]">
          <span className="text-text truncate">{show(t.token)}</span>
          <span className="text-dim ml-auto tabular-nums">{t.logit.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

export function WeightLens({ data }: Props) {
  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        L{data.layer} · unit {data.unit}, read from its weights — no prompt, no forward pass. This
        is what the neuron is <em>wired</em> to do on every input.
      </p>
      <div className="flex gap-4">
        <Column title="reads (cosine)" items={data.reads} />
        <Column title="promotes" items={data.promotes} />
        <Column title="suppresses" items={data.suppresses} />
      </div>
      <p className="text-dim mt-2 text-[10px] leading-relaxed">
        If these columns read as unrelated soup, that’s a finding: the neuron is polysemantic
        (superposition). Clean stories are the exception — verify any story with “Color the text by
        one neuron” on real text.
      </p>
    </div>
  );
}
