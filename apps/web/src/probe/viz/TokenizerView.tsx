// TokenizerView — the SEEING layer for tokenization.
//
// Token boundaries as alternating chips with ids and byte counts, plus the
// leading-space lesson when the input is a single word — the exact footgun
// that produced a wrong-looking J-lens grid in this workbench's own history.

import type { TokenizeResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: TokenizeResponse;
};

function show(s: string): string {
  return s.replace(/ /g, '·').replace(/\n/g, '⏎') || '∅';
}

export function TokenizerView({ data }: Props) {
  const { tokens, n_tokens, space_lesson } = data;

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        What the model actually sees: <span className="text-text font-mono">{n_tokens}</span> tokens
        (· marks a leading space — part of the token, not decoration).
      </p>
      <div className="flex flex-wrap gap-1">
        {tokens.map((t, i) => (
          <span
            key={i}
            title={`id ${t.id} · ${t.n_bytes} bytes`}
            className={[
              'rounded border px-1.5 py-0.5 font-mono text-[11px]',
              i % 2 === 0
                ? 'border-accent/30 bg-accent/10 text-text'
                : 'border-accent-soft/30 bg-accent-soft/10 text-text',
            ].join(' ')}
          >
            {show(t.token)}
            <span className="text-dim ml-1 text-[9px]">{t.id}</span>
          </span>
        ))}
      </div>
      {space_lesson && (
        <p className="border-accent-warm/30 bg-accent-warm/5 text-text mt-2 rounded border px-2 py-1.5 text-[11px] leading-relaxed">
          {space_lesson}
        </p>
      )}
      <p className="text-dim mt-2 text-[10px] leading-relaxed">
        Try: a number with decimals, a rare word, the same word with and without a leading space.
        Most “the model is being weird” mysteries start here.
      </p>
    </div>
  );
}
