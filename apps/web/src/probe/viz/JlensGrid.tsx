// JlensGrid — the SEEING layer for the J-lens workspace readout.
//
// Rows = probe layers (early → late), cols = token positions; each cell shows
// the token most POISED in the workspace there, brightness = its probability.
// Click a cell for its top-k. Paper-loyal extras:
//   - layer regimes: rows are annotated from per-model measured stats — early
//     layers are noisy ("pre"), the last layers align with the imminent output
//     ("motor"); the unmarked middle is the workspace band.
//   - pinned tokens: type tokens to track and read their RANK at every layer
//     for the selected position — the paper's rank-trajectory affordance.

import { useEffect, useState } from 'react';
import {
  getJlensPinned,
  getJlensStats,
  type JlensPinnedResponse,
  type JlensResponse,
  type JlensStatsResponse,
} from '../../api/mi-endpoints.js';

type Props = {
  data: JlensResponse;
};

const MOTOR_AGREEMENT = 0.5; // top-1 agreement with true output above this = "motor" regime
const PRE_WORKSPACE_PCT = 33; // paper: roughly the first third is noisy / uninterpretable

function show(s: string): string {
  return (s ?? '').replace(/ /g, '·') || '∅';
}

export function JlensGrid({ data }: Props) {
  const { tokens, layers, layer_pct, grid, j_cached, j_seconds, model_id, prompt } = data;
  const [sel, setSel] = useState<{ layer: number; pos: number } | null>(null);
  const [stats, setStats] = useState<JlensStatsResponse | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinned, setPinned] = useState<JlensPinnedResponse | null>(null);
  const [pinning, setPinning] = useState(false);

  // Per-model layer regimes, measured once (cheap; backend caches the reader).
  useEffect(() => {
    let alive = true;
    getJlensStats(model_id)
      .then((s) => {
        if (alive && !s.stub) setStats(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [model_id]);

  async function runPin() {
    const toks = pinInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (toks.length === 0) return;
    setPinning(true);
    try {
      const res = await getJlensPinned({ model_id, prompt, pinned: toks });
      if (!res.stub) setPinned(res);
    } catch {
      // leave prior state
    } finally {
      setPinning(false);
    }
  }

  function regime(li: number): 'pre' | 'motor' | 'workspace' {
    const pct = layer_pct[li] ?? 0;
    const agree = stats?.output_agreement[li];
    if (agree != null && agree > MOTOR_AGREEMENT) return 'motor';
    if (pct < PRE_WORKSPACE_PCT) return 'pre';
    return 'workspace';
  }

  const selCell = sel ? (grid[String(sel.layer)]?.[sel.pos] ?? null) : null;
  const selMax = selCell ? Math.max(...selCell.map(([, p]) => p), 1e-9) : 1;
  const rankPos = sel?.pos ?? tokens.length - 1;

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Each cell: the token most poised in the workspace at that (layer, position); brighter = more
        probable. Click a cell for its top-k.{' '}
        {j_cached ? (
          <span>Jacobian: cached.</span>
        ) : (
          <span className="text-accent-warm">
            Jacobian computed fresh in {j_seconds}s (cached for next time).
          </span>
        )}{' '}
        {stats && (
          <span>
            Layer regimes measured for this model: <span className="text-dim/80">pre</span> ·
            workspace · <span className="text-accent-warm">motor</span>.
          </span>
        )}
      </p>

      <div className="border-line max-h-72 overflow-auto rounded border">
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="bg-panel sticky top-0 z-10" />
              {tokens.map((tok, p) => (
                <th
                  key={p}
                  title={tok}
                  className="bg-panel text-dim sticky top-0 z-10 max-w-[64px] truncate px-1 py-0.5 text-left font-mono text-[9px] font-medium"
                >
                  {show(tok)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {layers.map((L, li) => {
              const row = grid[String(L)];
              if (!row) return null;
              const reg = regime(li);
              return (
                <tr key={L} className={reg === 'pre' ? 'opacity-60' : ''}>
                  <td className="text-dim whitespace-nowrap pl-1 pr-2 text-right font-mono text-[9px]">
                    {reg === 'motor' && (
                      <span className="text-accent-warm mr-1 text-[8px]">motor</span>
                    )}
                    {reg === 'pre' && <span className="mr-1 text-[8px] opacity-70">pre</span>}L{L} ·{' '}
                    {layer_pct[li]}%
                  </td>
                  {row.map((cands, p) => {
                    const first = cands[0];
                    const tok = first?.[0] ?? '';
                    const prob = first?.[1] ?? 0;
                    const a = Math.max(0.05, Math.min(1, prob)).toFixed(3);
                    const isSel = sel?.layer === L && sel?.pos === p;
                    return (
                      <td key={p} className="p-px">
                        <button
                          type="button"
                          onClick={() => setSel({ layer: L, pos: p })}
                          title={`L${L} · "${tokens[p]}" · p=${prob.toFixed(3)}`}
                          className={[
                            'text-text block max-w-[80px] min-w-[52px] truncate rounded-[3px] border px-1 py-0.5 text-left font-mono text-[9px]',
                            isSel ? 'border-accent-warm' : 'border-transparent',
                          ].join(' ')}
                          style={{ background: `rgba(251,146,60,${a})` }}
                        >
                          {show(tok)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sel && selCell && (
        <div className="border-line bg-panel-2/50 mt-2 rounded border px-2 py-1.5">
          <div className="text-dim mb-1 text-[9px] uppercase tracking-[0.15em]">
            L{sel.layer} · position {sel.pos} (“{show(tokens[sel.pos] ?? '')}”)
          </div>
          {selCell.map(([tok, prob], i) => (
            <div key={i} className="flex items-center gap-1.5 font-mono text-[10px]">
              <span className="text-text w-20 truncate">{show(tok)}</span>
              <div
                className="bg-accent-warm/80 h-1.5 rounded"
                style={{ width: `${Math.max(3, (prob / selMax) * 90)}px` }}
              />
              <span className="text-dim ml-auto tabular-nums">{(prob * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Pinned-token rank trajectories (the paper's exploration affordance). */}
      <div className="border-line mt-2 rounded border px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runPin();
            }}
            placeholder="Pin tokens (comma-separated), e.g. Paris, France"
            className="border-line bg-obsidian text-text focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-[10px] outline-none transition-colors"
          />
          <button
            type="button"
            onClick={() => void runPin()}
            disabled={pinning}
            className="border-line text-dim hover:text-text rounded border px-2 py-1 text-[10px] disabled:opacity-50"
          >
            {pinning ? '…' : 'track'}
          </button>
        </div>
        {pinned && (
          <div className="mt-1.5 space-y-0.5">
            <div className="text-dim text-[9px] uppercase tracking-[0.15em]">
              rank per layer at position {rankPos} (“{show(tokens[rankPos] ?? '')}”) — 1 = top of
              the workspace
            </div>
            {Object.entries(pinned.ranks).map(([tok, hm]) => {
              const traj = pinned.layers.map((_, li) => hm[li]?.[rankPos] ?? 0);
              const best = Math.min(...traj.filter((r) => r > 0), Infinity);
              return (
                <div key={tok} className="flex items-baseline gap-1.5 font-mono text-[9px]">
                  <span className="text-text w-16 shrink-0 truncate">{show(tok)}</span>
                  <span className="text-dim flex flex-wrap gap-x-1.5">
                    {traj.map((r, li) => (
                      <span
                        key={li}
                        className={r === best ? 'text-accent-warm' : ''}
                        title={`L${pinned.layers[li]}`}
                      >
                        {r > 0 ? r.toLocaleString() : '-'}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
