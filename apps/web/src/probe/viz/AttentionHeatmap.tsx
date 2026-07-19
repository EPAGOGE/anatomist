// AttentionHeatmap — the SEEING layer for the attention-pattern probe.
//
// Renders the [query][key] attention matrix as a grid. Each row is a query
// token (the word doing the looking); each column is a key token (a word it
// could look at); cell brightness is the attention weight. Hover a cell to
// read the exact value. Causal models give a lower-triangular shape (a word
// can only attend to itself + earlier words).

type Props = {
  tokens: string[];
  /** pattern[i][j] = how much query token i attends to key token j. */
  pattern: number[][];
};

function cellColor(value: number): string {
  // Fuchsia accent at value=1, transparent at 0. Clamp for safety.
  const v = Math.max(0, Math.min(1, value));
  return `rgba(244, 114, 182, ${v.toFixed(3)})`;
}

function short(token: string): string {
  const t = token.replace(/\s+/g, '·');
  return t.length > 6 ? t.slice(0, 6) + '…' : t;
}

export function AttentionHeatmap({ tokens, pattern }: Props) {
  const n = tokens.length;
  if (n === 0 || pattern.length === 0) {
    return <div className="text-dim p-4 text-center text-xs">No tokens to display.</div>;
  }

  // Column template: one label gutter + n cells.
  const gridCols = `minmax(48px, auto) repeat(${n}, minmax(18px, 1fr))`;

  return (
    <div className="overflow-auto">
      <div className="inline-grid gap-px" style={{ gridTemplateColumns: gridCols }}>
        {/* Header row: empty corner + key-token labels */}
        <div className="bg-panel sticky left-0 top-0 z-10" />
        {tokens.map((tok, j) => (
          <div
            key={`col-${j}`}
            title={tok}
            className="text-dim flex items-end justify-center pb-1 font-mono text-[9px]"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 44 }}
          >
            {short(tok)}
          </div>
        ))}

        {/* Body rows: query label + cells */}
        {tokens.map((qTok, i) => (
          <Row key={`row-${i}`} qTok={qTok} rowIndex={i} row={pattern[i] ?? []} tokens={tokens} />
        ))}
      </div>
      <div className="text-dim mt-2 flex items-center gap-2 px-1 text-[9px] uppercase tracking-[0.15em]">
        <span>rows = query (looking)</span>
        <span className="bg-line h-2.5 w-px" />
        <span>cols = key (looked at)</span>
        <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
          <span
            className="inline-block h-2 w-8 rounded-sm"
            style={{ background: 'linear-gradient(90deg, transparent, rgb(244,114,182))' }}
          />
          0 → 1
        </span>
      </div>
    </div>
  );
}

function Row({
  qTok,
  rowIndex,
  row,
  tokens,
}: {
  qTok: string;
  rowIndex: number;
  row: number[];
  tokens: string[];
}) {
  return (
    <>
      <div
        title={qTok}
        className="text-dim bg-panel sticky left-0 flex items-center justify-end pr-2 font-mono text-[9px]"
      >
        {short(qTok)}
      </div>
      {tokens.map((kTok, j) => {
        const v = row[j] ?? 0;
        return (
          <div
            key={`cell-${rowIndex}-${j}`}
            title={`"${qTok.trim()}" → "${kTok.trim()}":  ${v.toFixed(3)}`}
            className="aspect-square min-h-[18px] border border-black/20"
            style={{ background: cellColor(v) }}
          />
        );
      })}
    </>
  );
}
