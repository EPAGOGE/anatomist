// FirstRun — the first five minutes, spelled out.
//
// Pedagogy (the Karpathy route): show the real thing immediately, verify your
// instrument before trusting it, keep every claim concrete, and end with a
// hunt rather than a lecture. Three steps, each one earned before the next
// unlocks. Shown when no model is loaded and the intro hasn't been dismissed.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleNotch, CheckCircle } from '@phosphor-icons/react';
import { loadModel, runCanary, type CanaryResponse } from '../api/mi-endpoints.js';

const DISMISS_KEY = 'mi-first-run-done';

export function firstRunDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function dismiss(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // private mode etc. — the card just reappears next visit
  }
}

type Props = {
  /** True once any model is loaded (step 1 complete). */
  modelLoaded: boolean;
  /** Fire the first probe (attention pattern on the default prompt). */
  onFirstProbe: () => void;
  /** Re-render hook for the parent after dismissal. */
  onDismiss: () => void;
};

export function FirstRun({ modelLoaded, onFirstProbe, onDismiss }: Props) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canary, setCanary] = useState<CanaryResponse | null>(null);
  const [checking, setChecking] = useState(false);

  const verified = canary?.verdict === 'verified';

  async function stepOne() {
    setLoading(true);
    setLoadError(null);
    try {
      await loadModel('gpt2');
      await queryClient.invalidateQueries({ queryKey: ['mi-loaded'] });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }

  async function stepTwo() {
    setChecking(true);
    try {
      setCanary(await runCanary('gpt2'));
    } catch {
      setCanary(null);
    } finally {
      setChecking(false);
    }
  }

  function stepThree() {
    dismiss();
    onFirstProbe();
    onDismiss();
  }

  return (
    <div className="space-y-4 px-3 py-4">
      <div>
        <div className="text-text text-sm font-semibold">Look inside a real neural network</div>
        <p className="text-dim mt-1 text-[11px] leading-relaxed">
          Not a diagram of one — the actual thing: its attention, its activations, its half-formed
          guesses mid-computation. Three steps, about two minutes.
        </p>
      </div>

      {/* Step 1 */}
      <Step
        n={1}
        done={modelLoaded}
        title="Put a model on the bench"
        body="gpt2: 124 million parameters, the lab rat of interpretability. Small enough for a laptop, big enough to have real structure worth finding. The first load downloads ~500 MB; after that it takes seconds."
      >
        {!modelLoaded && (
          <>
            <ActionButton onClick={() => void stepOne()} busy={loading}>
              {loading ? 'downloading + loading… (one time)' : 'Load gpt2'}
            </ActionButton>
            {loadError && <p className="text-warn mt-1 text-[10px]">{loadError}</p>}
          </>
        )}
      </Step>

      {/* Step 2 */}
      <Step
        n={2}
        done={verified}
        locked={!modelLoaded}
        title="Make the instrument prove itself"
        body="Rule one of measuring anything: first check that the meter isn't lying. This runs three checks whose correct answers we know without trusting the model: attention must be causal, its rows must sum to 1, and the lens at the last layer must equal the model's true output. If one fails, the tool is broken, not the model. (We once shipped a subtly-miscalibrated lens; this is how it would have been caught on day one.)"
      >
        {modelLoaded && !verified && (
          <ActionButton onClick={() => void stepTwo()} busy={checking}>
            {checking ? 'checking…' : 'Run the self-test'}
          </ActionButton>
        )}
        {canary && !verified && (
          <p className="text-warn mt-1 text-[10px]">
            verdict: {canary.verdict} — the instrument has a problem; probe results can’t be trusted
            until this passes.
          </p>
        )}
        {verified && (
          <p className="text-success mt-1 text-[10px]">
            ✓ verified — all three invariants hold. Now the numbers mean something.
          </p>
        )}
      </Step>

      {/* Step 3 */}
      <Step
        n={3}
        done={false}
        locked={!verified}
        title="Take your first look"
        body="Attention is the part you can literally see: a grid of which earlier words each word looked at while the model read your prompt. Run it, then go hunting. Somewhere in this model is a head that does nothing but stare at the word before it (a bright stripe just under the diagonal). It exists. Flip through layers and heads until you catch it."
      >
        {verified && <ActionButton onClick={stepThree}>Show me who looks at whom</ActionButton>}
      </Step>

      <button
        type="button"
        onClick={() => {
          dismiss();
          onDismiss();
        }}
        className="text-dim hover:text-text text-[10px] underline-offset-2 hover:underline"
      >
        skip the intro
      </button>
    </div>
  );
}

function Step({
  n,
  title,
  body,
  done,
  locked,
  children,
}: {
  n: number;
  title: string;
  body: string;
  done: boolean;
  locked?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={[
        'border-line rounded-lg border p-3 transition-opacity',
        locked ? 'opacity-40' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        {done ? (
          <CheckCircle size={16} weight="fill" className="text-success shrink-0" />
        ) : (
          <span className="border-line text-dim flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]">
            {n}
          </span>
        )}
        <span className={['text-[12px] font-semibold', done ? 'text-dim' : 'text-text'].join(' ')}>
          {title}
        </span>
      </div>
      <p className="text-dim mt-1.5 text-[11px] leading-relaxed">{body}</p>
      {!locked && <div className="mt-2">{children}</div>}
    </div>
  );
}

function ActionButton({
  onClick,
  busy,
  children,
}: {
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="bg-accent/15 text-accent hover:bg-accent/25 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition disabled:opacity-60"
    >
      {busy && <CircleNotch size={12} className="animate-spin" />}
      {children}
    </button>
  );
}
