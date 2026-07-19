// Per-model card in the MI Workbench Model Library (Subsystem 1).
//
// Renders a single ModelEntry with its tool-availability matrix and a
// load button. When loading, shows a spinner; on error, surfaces the
// backend's error message inline (most common: HF_TOKEN missing or
// license unaccepted for Gemma).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle,
  CircleNotch,
  Download,
  MinusCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import { loadModel, unloadModel, type ModelEntry } from '../../api/mi-endpoints.js';
import type { MiApiError } from '../../api/mi-client.js';

type Props = {
  model: ModelEntry;
  isLoaded: boolean;
};

const TOOL_LABELS: Array<{ key: keyof ModelEntry['tools']; label: string; tooltip: string }> = [
  {
    key: 'transformer_lens',
    label: 'TransformerLens',
    tooltip: 'Hookable forward pass: attention patterns, residual streams, MLP activations.',
  },
  {
    key: 'gemma_scope',
    label: 'Gemma Scope',
    tooltip: 'Google DeepMind SAE features for this model. Browse and steer.',
  },
  {
    key: 'nla_anthropic',
    label: 'NLA',
    tooltip: 'Anthropic Natural Language Autoencoder: feature decomposition.',
  },
  {
    key: 'custom_saes',
    label: 'Community SAEs',
    tooltip: 'Sparse autoencoders trained by the research community.',
  },
];

export function ModelCard({ model, isLoaded }: Props) {
  const queryClient = useQueryClient();

  const loadMutation = useMutation({
    mutationFn: () => loadModel(model.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mi-loaded'] });
    },
  });

  const unloadMutation = useMutation({
    mutationFn: () => unloadModel(model.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mi-loaded'] });
    },
  });

  const isBusy = loadMutation.isPending || unloadMutation.isPending;
  const error = (loadMutation.error ?? unloadMutation.error) as MiApiError | null;

  return (
    <article className="border-line bg-panel hover:border-accent/40 group relative rounded-lg border p-4 transition">
      {isLoaded && (
        <span
          className="border-line text-dim absolute right-3 top-3 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]"
          aria-label="loaded"
        >
          loaded
        </span>
      )}

      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-text truncate text-sm font-semibold">{model.display_name}</h3>
          <p className="text-dim mt-0.5 truncate font-mono text-[11px]">{model.id}</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="text-dim mb-3 flex items-center gap-3 text-[10px] uppercase tracking-[0.15em]">
        <span>
          <span className="text-text font-mono normal-case tracking-normal">
            {model.params_b < 1
              ? `${(model.params_b * 1000).toFixed(0)}M`
              : `${model.params_b.toFixed(1)}B`}
          </span>{' '}
          params
        </span>
        <span className="bg-line h-3 w-px" />
        <span title={model.gated ? 'License acceptance required' : 'Public download'}>
          {model.license}
        </span>
        {model.gated && (
          <span
            className="text-accent-warm/90 ml-auto"
            title="HF_TOKEN required with accepted license"
          >
            gated
          </span>
        )}
      </div>

      {/* Tool availability matrix */}
      <ul className="mb-3 flex flex-wrap gap-1.5">
        {TOOL_LABELS.map(({ key, label, tooltip }) => {
          const available = model.tools[key];
          return (
            <li key={key}>
              <span
                title={tooltip}
                className={[
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition',
                  available
                    ? 'border-accent-soft/30 bg-accent-soft/10 text-accent-soft'
                    : 'border-line bg-panel-2 text-dim/60',
                ].join(' ')}
              >
                {available ? (
                  <CheckCircle size={9} weight="duotone" />
                ) : (
                  <MinusCircle size={9} weight="regular" />
                )}
                {label}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Notes */}
      {model.notes && <p className="text-dim mb-3 text-[11px] leading-relaxed">{model.notes}</p>}

      {/* Action row */}
      <div className="border-line flex items-center gap-2 border-t pt-3">
        {!isLoaded ? (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => loadMutation.mutate()}
            className="border-accent-soft/40 bg-accent-soft/10 text-accent-soft hover:border-accent-soft/70 hover:bg-accent-soft/15 inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition disabled:cursor-wait disabled:opacity-60"
          >
            {loadMutation.isPending ? (
              <>
                <CircleNotch size={12} weight="bold" className="animate-spin" />
                loading…
              </>
            ) : (
              <>
                <Download size={12} weight="bold" />
                load
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => unloadMutation.mutate()}
            className="border-line bg-panel-2 text-dim hover:border-warn/40 hover:text-warn inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs transition disabled:cursor-wait disabled:opacity-60"
          >
            {unloadMutation.isPending ? (
              <>
                <CircleNotch size={12} weight="bold" className="animate-spin" />
                unloading…
              </>
            ) : (
              <>unload</>
            )}
          </button>
        )}
      </div>

      {/* Error reveal */}
      {error && (
        <div className="border-warn/30 bg-warn/5 text-warn mt-3 flex items-start gap-2 rounded border px-2.5 py-2 text-[11px] leading-snug">
          <WarningCircle size={12} weight="duotone" className="mt-0.5 shrink-0" />
          <span>{error.message}</span>
        </div>
      )}
    </article>
  );
}
