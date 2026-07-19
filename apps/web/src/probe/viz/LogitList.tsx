// LogitList — the SEEING layer for the logit-lens probe.
//
// The model's top guesses for the next word, as of the chosen layer. Each
// row is a candidate token with a probability bar. Watching how this list
// changes across layers shows the answer forming.

export type TopToken = { token: string; logit: number; prob: number };

type Props = {
  topTokens: TopToken[];
};

export function LogitList({ topTokens }: Props) {
  if (topTokens.length === 0) {
    return <div className="text-dim p-4 text-center text-xs">No predictions to display.</div>;
  }
  const max = Math.max(...topTokens.map((t) => t.prob), 1e-6);

  return (
    <div className="flex flex-col gap-1.5">
      {topTokens.map((t, i) => {
        const pct = Math.max(2, (t.prob / max) * 100);
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="text-dim w-5 shrink-0 text-right font-mono text-[10px] tabular-nums">
              {i + 1}
            </span>
            <span
              className="text-text border-line bg-panel-2 shrink-0 rounded border px-1.5 py-0.5 font-mono text-[11px]"
              title={`logit ${t.logit.toFixed(2)} · prob ${(t.prob * 100).toFixed(1)}%`}
            >
              {t.token.replace(/\s/g, '·') || '∅'}
            </span>
            <div className="bg-panel-2 relative h-3 flex-1 overflow-hidden rounded">
              <div
                className="bg-accent/70 absolute inset-y-0 left-0 rounded"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-dim w-12 shrink-0 text-right font-mono text-[10px] tabular-nums">
              {(t.prob * 100).toFixed(1)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
