// AblationCompare — the SEEING layer for the head-ablation probe.
//
// Two ranked next-token lists side by side: clean vs head-off. Tokens that
// appear in one column but not the other are highlighted (accent-warm) —
// that's the visible signature of what the head was contributing. If the
// columns match, the head did little for this input (the common case — most
// heads are specialists).

import type { TopToken } from '../../api/mi-endpoints.js';

type Props = {
  cleanTop: TopToken[];
  ablatedTop: TopToken[];
};

export function AblationCompare({ cleanTop, ablatedTop }: Props) {
  const cleanSet = new Set(cleanTop.map((t) => t.token));
  const ablatedSet = new Set(ablatedTop.map((t) => t.token));

  const moved =
    cleanTop.length > 0 &&
    ablatedTop.length > 0 &&
    (cleanTop[0]?.token !== ablatedTop[0]?.token ||
      cleanTop.some((t, i) => ablatedTop[i]?.token !== t.token));

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Column title="clean" tokens={cleanTop} otherSet={ablatedSet} />
        <Column title="head off" tokens={ablatedTop} otherSet={cleanSet} />
      </div>
      <p className="text-dim mt-2 px-1 text-[10px] leading-relaxed">
        {moved
          ? 'The prediction moved. This head was contributing here.'
          : 'Nearly identical. This head did little for this input. Most heads don’t; finding the ones that do is the point.'}
      </p>
    </div>
  );
}

function Column({
  title,
  tokens,
  otherSet,
}: {
  title: string;
  tokens: TopToken[];
  otherSet: Set<string>;
}) {
  const max = Math.max(...tokens.map((t) => t.prob), 1e-6);
  return (
    <div>
      <div className="text-dim mb-1 text-[10px] uppercase tracking-[0.15em]">{title}</div>
      <div className="flex flex-col gap-1">
        {tokens.map((t, i) => {
          const novel = !otherSet.has(t.token); // not in the other column = a change
          const pct = Math.max(2, (t.prob / max) * 100);
          return (
            <div key={i} className="flex items-center gap-1.5">
              <span
                className={[
                  'shrink-0 rounded border px-1 py-0.5 font-mono text-[10px]',
                  novel
                    ? 'border-accent-warm/50 bg-accent-warm/10 text-accent-warm'
                    : 'border-line bg-panel-2 text-text',
                ].join(' ')}
                title={`logit ${t.logit.toFixed(2)} · ${(t.prob * 100).toFixed(1)}%`}
              >
                {t.token.replace(/\s/g, '·') || '∅'}
              </span>
              <div className="bg-panel-2 relative h-2.5 flex-1 overflow-hidden rounded">
                <div
                  className={[
                    'absolute inset-y-0 left-0 rounded',
                    novel ? 'bg-accent-warm/70' : 'bg-accent-soft/60',
                  ].join(' ')}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
