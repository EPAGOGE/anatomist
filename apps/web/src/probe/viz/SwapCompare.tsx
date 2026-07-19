// SwapCompare — the SEEING layer for the lens-coordinate swap.
//
// The paper's causal workhorse rendered as a before/after: the clean greedy
// continuation next to the continuation after the SOURCE thought's lens
// coordinates were exchanged for the TARGET's across the workspace band.
// If the answer follows the thought, you just watched causality — the swap
// changed what the model SAID by changing what it was THINKING.

import type { JlensSwapResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: JlensSwapResponse;
};

export function SwapCompare({ data }: Props) {
  const { source, target, band_pct, clean, swapped } = data;
  const changed = clean.trim() !== swapped.trim();

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Swapped <span className="text-accent-warm font-mono">{source.trim()}</span> →{' '}
        <span className="font-mono" style={{ color: 'rgb(129,140,248)' }}>
          {target.trim()}
        </span>{' '}
        in lens coordinates across the {band_pct[0]}–{band_pct[band_pct.length - 1]}% layer band,
        then let the model keep talking.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div className="border-line rounded border p-2">
          <div className="text-dim mb-1 text-[9px] uppercase tracking-[0.15em]">clean</div>
          <div className="text-text font-mono text-[11px] leading-relaxed">{clean || '∅'}</div>
        </div>
        <div
          className={['rounded border p-2', changed ? 'border-accent-warm/50' : 'border-line'].join(
            ' ',
          )}
        >
          <div className="text-dim mb-1 text-[9px] uppercase tracking-[0.15em]">after the swap</div>
          <div className="text-text font-mono text-[11px] leading-relaxed">{swapped || '∅'}</div>
        </div>
      </div>

      <p className="text-dim mt-2 text-[10px] leading-relaxed">
        {changed ? (
          <>
            The continuation moved — the swapped thought was causally load-bearing. (Whether it
            moved <em>toward the target</em> is yours to judge above.)
          </>
        ) : (
          <>
            No change — per the paper, swaps mostly fail when the source concept is only weakly
            loaded in the workspace. Check its rank first by pinning it on the J-lens grid.
          </>
        )}
      </p>
    </div>
  );
}
