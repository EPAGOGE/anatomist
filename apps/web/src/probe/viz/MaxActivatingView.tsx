// MaxActivatingView — dataset evidence for one unit: the corpus passages that
// fire it hardest, each rendered as activation-colored text. Weight-lens
// labels are a prior; this is the ground truth ("look at your data").

import type { MaxActivatingResponse } from '../../api/mi-endpoints.js';
import { TokenHeat } from './TokenHeat.js';

type Props = {
  data: MaxActivatingResponse;
};

export function MaxActivatingView({ data }: Props) {
  const { layer, unit, examples, corpus_size } = data;

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Passages that fire L{layer} · unit {unit} hardest, from the built-in {corpus_size}-sentence
        corpus. Honest scope: a first look, not a census — a unit's real story needs a bigger sweep.
      </p>
      <div className="space-y-2">
        {examples.map((e, i) => (
          <div key={i}>
            <div className="text-dim mb-0.5 font-mono text-[9px]">
              max {e.max_value.toFixed(2)} on {e.max_token.replace(/ /g, '·')}
            </div>
            <TokenHeat
              tokens={e.tokens.map((tok, j) => ({ token: tok, value: e.activations[j] ?? 0 }))}
              legend=""
            />
          </div>
        ))}
      </div>
      <p className="text-dim mt-2 text-[10px] leading-relaxed">
        If these passages share nothing obvious, the unit is polysemantic — cross-check with the
        weight lens and unit-over-text on your own sentences.
      </p>
    </div>
  );
}
