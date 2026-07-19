// ModelDiffView — same prompt, two brains: per-token surprisal side by side.
//
// The Δ column is the point: where model A is calm and model B is shocked
// (or vice versa) is exactly what the parameter difference bought. Rows with
// |Δ| > 2 bits get flagged.

import type { ModelDiffResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: ModelDiffResponse;
};

function show(s: string): string {
  return s.replace(/ /g, '·').replace(/\n/g, '⏎') || '∅';
}

const DIVERGE_BITS = 2;

export function ModelDiffView({ data }: Props) {
  const { model_id, model_b, tokens, surprisal_a, surprisal_b, top_a, top_b } = data;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr className="text-dim">
              <th className="pb-1 text-left font-medium">token</th>
              <th className="pb-1 text-right font-mono">{model_id}</th>
              <th className="pb-1 text-right font-mono">{model_b}</th>
              <th className="pb-1 text-right font-mono">Δ</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {tokens.map((tok, i) => {
              const a = surprisal_a[i] ?? 0;
              const b = surprisal_b[i] ?? 0;
              const d = a - b;
              const diverges = Math.abs(d) > DIVERGE_BITS && i > 0;
              return (
                <tr key={i} className={diverges ? 'text-accent-warm' : 'text-text'}>
                  <td className="py-0.5">{show(tok)}</td>
                  <td className="py-0.5 text-right tabular-nums">{a.toFixed(2)}</td>
                  <td className="py-0.5 text-right tabular-nums">{b.toFixed(2)}</td>
                  <td className="py-0.5 text-right tabular-nums">
                    {i > 0 ? (d > 0 ? '+' : '') + d.toFixed(2) : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-dim mt-2 space-y-0.5 text-[10px]">
        <div>
          <span className="font-mono">{model_id}</span> next:{' '}
          {top_a
            .slice(0, 3)
            .map((t) => `${show(t.token)} ${(t.prob * 100).toFixed(0)}%`)
            .join('  ')}
        </div>
        <div>
          <span className="font-mono">{model_b}</span> next:{' '}
          {top_b
            .slice(0, 3)
            .map((t) => `${show(t.token)} ${(t.prob * 100).toFixed(0)}%`)
            .join('  ')}
        </div>
      </div>
      <p className="text-dim mt-2 text-[10px] leading-relaxed">
        Δ = {model_id} bits − {model_b} bits: negative rows are where {model_id} is calmer (usually
        what its extra parameters bought); highlighted rows diverge by more than {DIVERGE_BITS}{' '}
        bits.
      </p>
    </div>
  );
}
