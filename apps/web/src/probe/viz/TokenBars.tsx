// TokenBars — the SEEING layer for the activation-strength probe.
//
// One horizontal bar per token; bar length is the activation norm at the
// chosen layer, scaled to the largest norm in the set. Taller/longer bar =
// the model is doing more with that token at this layer.

type Props = {
  tokens: string[];
  /** Per-token L2 norm of the activation. Length matches tokens. */
  norms: number[];
};

function short(token: string): string {
  const t = token.replace(/\s+/g, '·');
  return t.length > 14 ? t.slice(0, 14) + '…' : t;
}

export function TokenBars({ tokens, norms }: Props) {
  if (tokens.length === 0 || norms.length === 0) {
    return <div className="text-dim p-4 text-center text-xs">No activations to display.</div>;
  }
  const max = Math.max(...norms, 1e-6);

  return (
    <div className="flex flex-col gap-1.5">
      {tokens.map((tok, i) => {
        const v = norms[i] ?? 0;
        const pct = Math.max(2, (v / max) * 100);
        return (
          <div key={i} className="flex items-center gap-2">
            <span
              title={tok}
              className="text-dim w-20 shrink-0 truncate text-right font-mono text-[10px]"
            >
              {short(tok)}
            </span>
            <div className="bg-panel-2 relative h-4 flex-1 overflow-hidden rounded">
              <div
                className="bg-accent-soft/70 absolute inset-y-0 left-0 rounded"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-dim w-12 shrink-0 font-mono text-[10px] tabular-nums">
              {v.toFixed(1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
