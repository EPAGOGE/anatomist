// TokenHeat — text colored by a per-token value, rendered as flowing prose.
//
// The shared SEEING layer for two probes:
//   - surprisal: red heat = the model was surprised (hover shows what it
//     expected instead) — reading text through the model's eyes.
//   - unit activation: warm = the unit fires here — the char-rnn classic,
//     reading along with one neuron.
//
// Values are normalized to the observed max so both use-cases render well;
// sign-aware mode dims negatives instead of clipping them.

import { useState } from 'react';

export type HeatToken = {
  token: string;
  value: number;
  /** Optional hover detail lines (e.g. "expected: ' Paris' (34%)"). */
  detail?: string[];
};

type Props = {
  tokens: HeatToken[];
  /** Legend text under the prose, e.g. "0 bits · calm — 24.8 bits · shocked". */
  legend: string;
};

function show(s: string): string {
  return s.replace(/\n/g, '⏎');
}

export function TokenHeat({ tokens, legend }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...tokens.map((t) => Math.abs(t.value)), 1e-9);

  return (
    <div>
      <div className="border-line bg-obsidian/40 rounded-lg border px-3 py-2.5 font-mono text-[13px] leading-[1.9]">
        {tokens.map((t, i) => {
          const a = Math.min(1, Math.abs(t.value) / max);
          const bg =
            t.value >= 0
              ? `rgba(251,113,60,${(0.85 * a).toFixed(3)})`
              : `rgba(96,165,250,${(0.85 * a).toFixed(3)})`;
          return (
            <span
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="text-text relative cursor-default rounded-[3px] px-[1px]"
              style={{ background: bg }}
            >
              {show(t.token)}
              {hover === i && (
                <span className="border-line bg-panel absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded border px-2 py-1 text-[10px] shadow-lg">
                  <span className="text-accent-warm font-semibold">{t.value.toFixed(2)}</span>
                  {(t.detail ?? []).map((d, j) => (
                    <span key={j} className="text-dim block">
                      {d}
                    </span>
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <p className="text-dim mt-1.5 text-[10px]">{legend}</p>
    </div>
  );
}
