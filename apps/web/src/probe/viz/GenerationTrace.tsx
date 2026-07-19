// GenerationTrace — the SEEING layer for token-by-token generation.
//
// Each row: the token the model chose, how likely that choice was, the
// entropy of the full distribution at that moment (its uncertainty), and the
// candidates that lost. Watch certainty breathe: wide-open moments (high
// entropy) are where sampling temperature matters; near-zero entropy means
// the next token was effectively forced.

import type { GenerateTraceResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: GenerateTraceResponse;
};

function show(s: string): string {
  return s.replace(/ /g, '·').replace(/\n/g, '⏎') || '∅';
}

const MAX_ENTROPY_BAR = 14; // bits — gpt2's practical ceiling for display scaling

export function GenerationTrace({ data }: Props) {
  const { prompt, completion, temperature, steps } = data;

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        <span className="text-text font-mono">{prompt}</span>
        <span className="text-accent-warm font-mono">{completion}</span>
        <span className="ml-2">(temperature {temperature})</span>
      </p>
      <div className="space-y-1">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-[10px]">
            <span className="text-text w-20 shrink-0 truncate text-right font-mono">
              {show(s.token)}
            </span>
            <span className="text-dim w-12 shrink-0 font-mono tabular-nums">
              {(s.prob * 100).toFixed(0)}%
            </span>
            {/* entropy bar: the model's uncertainty at this moment */}
            <div className="bg-panel-2 relative h-2 w-24 shrink-0 overflow-hidden rounded">
              <div
                className="bg-accent-soft/70 absolute inset-y-0 left-0 rounded"
                style={{ width: `${Math.min(100, (s.entropy / MAX_ENTROPY_BAR) * 100)}%` }}
              />
            </div>
            <span className="text-dim w-14 shrink-0 font-mono tabular-nums">
              {s.entropy.toFixed(1)} bits
            </span>
            <span className="text-dim min-w-0 truncate font-mono">
              {s.candidates
                .slice(0, 4)
                .map((c) => `${show(c.token)} ${(c.prob * 100).toFixed(0)}%`)
                .join('  ')}
            </span>
          </div>
        ))}
      </div>
      <p className="text-dim mt-2 text-[10px] leading-relaxed">
        The bar is entropy — the model's uncertainty before each choice. Long bar = wide-open moment
        where temperature decides; short bar = the token was effectively forced.
      </p>
    </div>
  );
}
