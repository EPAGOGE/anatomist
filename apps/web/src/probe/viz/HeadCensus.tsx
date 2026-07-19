// HeadCensus — the SEEING layer for the all-heads census.
//
// Three known head signatures, each as a layer×head grid with its top scorers
// named. Prompt-independent: this characterizes the MODEL. The hunt from the
// first-run intro ends here — the previous-token head you were sent to find
// is provable, and the induction heads (the founding result of circuits
// research) light up alongside it.

import { useState } from 'react';
import type { HeadCensusResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: HeadCensusResponse;
};

const METRICS = [
  {
    key: 'prev_token' as const,
    label: 'previous-token',
    hint: 'stares at the word immediately before: the grammar glue',
  },
  {
    key: 'induction' as const,
    label: 'induction',
    hint: 'finds the last time the current token appeared and copies what came NEXT: in-context learning’s workhorse',
  },
  {
    key: 'sink' as const,
    label: 'attention sink',
    hint: 'parks attention on position 0 when it has nothing better to do: a no-op resting state',
  },
];

export function HeadCensus({ data }: Props) {
  const [metric, setMetric] = useState<(typeof METRICS)[number]>(METRICS[0]!);
  const grid = data[metric.key];
  const top = data.top[metric.key] ?? [];

  return (
    <div>
      <div className="mb-2 flex gap-1">
        {METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMetric(m)}
            className={[
              'rounded-full border px-2 py-0.5 text-[10px] transition',
              metric.key === m.key
                ? 'border-accent-soft/70 bg-accent-soft/20 text-accent-soft'
                : 'border-line text-dim hover:text-text',
            ].join(' ')}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">{metric.hint}</p>

      <div className="overflow-x-auto">
        <table className="border-collapse">
          <thead>
            <tr>
              <th />
              {Array.from({ length: data.n_heads }, (_, h) => (
                <th key={h} className="text-dim px-0.5 pb-0.5 text-center font-mono text-[8px]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, L) => (
              <tr key={L}>
                <td className="text-dim pr-1 text-right font-mono text-[8px]">L{L}</td>
                {row.map((v, h) => (
                  <td key={h} className="p-px">
                    <div
                      title={`L${L}·H${h} = ${v.toFixed(3)}`}
                      className="h-3.5 w-3.5 rounded-[2px]"
                      style={{ background: `rgba(251,146,60,${Math.max(0.04, v).toFixed(3)})` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-dim mt-2 text-[10px]">
        top {metric.label} heads:{' '}
        {top.slice(0, 3).map((h, i) => (
          <span key={i} className="text-accent-warm mr-2 font-mono">
            L{h.layer}·H{h.head} ({(h.score * 100).toFixed(0)}%)
          </span>
        ))}
      </div>
    </div>
  );
}
