// DirectionCurve — the SEEING layer for the concept-direction probe.
//
// One signed bar per layer: how aligned the prompt's residual is with the
// concept axis (pos − neg) at that depth. Warm = toward the concept, cool =
// toward its contrast. The shape is the finding: near-zero early rising
// through the middle = the model BUILDING the distinction; strong early bars
// = lexical overlap rather than semantics.

import type { ConceptDirectionResponse } from '../../api/mi-endpoints.js';

type Props = {
  data: ConceptDirectionResponse;
};

export function DirectionCurve({ data }: Props) {
  const { scores, best_layer, best_score } = data;
  const max = Math.max(...scores.map(Math.abs), 1e-9);

  return (
    <div>
      <p className="text-dim mb-2 text-[11px] leading-relaxed">
        Alignment with the concept axis at every layer. Strongest at{' '}
        <span className="text-accent-warm">
          layer {best_layer} ({best_score >= 0 ? '+' : ''}
          {best_score.toFixed(2)})
        </span>
        . Watch the shape: rising through the middle layers means the model is building the
        distinction; flat-near-zero means it never represents it for this prompt.
      </p>

      <div className="flex items-end gap-1" style={{ height: 96 }}>
        {scores.map((s, layer) => {
          const h = Math.max(2, (Math.abs(s) / max) * 44);
          const warm = s >= 0;
          const isBest = layer === best_layer;
          return (
            <div key={layer} className="flex flex-1 flex-col items-center justify-end self-stretch">
              {/* positive half */}
              <div className="flex w-full flex-1 items-end justify-center">
                {warm && (
                  <div
                    className={[
                      'w-full max-w-[18px] rounded-t',
                      isBest ? 'ring-accent-warm ring-1' : '',
                    ].join(' ')}
                    style={{ height: h, background: 'rgba(251,146,60,0.8)' }}
                  />
                )}
              </div>
              {/* axis */}
              <div className="bg-line h-px w-full" />
              {/* negative half */}
              <div className="flex w-full flex-1 items-start justify-center">
                {!warm && (
                  <div
                    className={[
                      'w-full max-w-[18px] rounded-b',
                      isBest ? 'ring-1 ring-indigo-400' : '',
                    ].join(' ')}
                    style={{ height: h, background: 'rgba(129,140,248,0.8)' }}
                  />
                )}
              </div>
              <div className="text-dim mt-0.5 font-mono text-[8px] tabular-nums">{layer}</div>
            </div>
          );
        })}
      </div>
      <div className="text-dim mt-1 flex items-center gap-2 text-[9px] uppercase tracking-[0.15em]">
        <span>layers →</span>
        <span className="ml-auto flex items-center gap-2 normal-case tracking-normal">
          <span style={{ color: 'rgb(251,146,60)' }}>▮ toward concept</span>
          <span style={{ color: 'rgb(129,140,248)' }}>▮ toward contrast</span>
        </span>
      </div>
    </div>
  );
}
