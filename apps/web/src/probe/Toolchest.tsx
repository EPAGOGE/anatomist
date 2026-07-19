// Toolchest — the MI Toolchest panel (Subsystem 3).
//
// Intent-first buttons: you click "See which words a head pays attention to,"
// not "run_with_cache." You click because you already know your goal. Clicking
// runs the probe on the backend and hands the result up to the canvas, which
// opens a ProbeResultCard — the four-representation learning fold.
//
// Shared controls (prompt, layer, head, top-k) sit at the top; each probe
// reads the subset it needs. Buttons are grouped by what you're trying to
// accomplish (Inspect / Intervene / Features / Circuits), never by function
// name.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleNotch } from '@phosphor-icons/react';
import {
  ablateHead,
  ablateSweep,
  getActivations,
  getAttentionPattern,
  getLoadedModels,
  getConceptDirection,
  getGenerateTrace,
  getHeadCensus,
  getJlens,
  getJlensReady,
  getLogitLens,
  getMaxActivating,
  getModelDiff,
  getNeurons,
  getSaliency,
  getSurprisal,
  getTokenize,
  getUnitActivation,
  getWeightLens,
  jlensSwap,
  logitAttribution,
  nextTokens,
  patchActivations,
  runCanary,
} from '../api/mi-endpoints.js';
import type { CanaryResponse } from '../api/mi-endpoints.js';
import { getSaeFeatures, saeAblateFeature } from '../api/sae-endpoints.js';
import {
  CATEGORY_LABELS,
  PROBES,
  PROBES_BY_CATEGORY,
  type ProbeCategory,
  type ProbeDefinition,
} from './toolchest-catalog.js';
import type { ProbeResult, ProbeRun } from './ProbeResultCard.js';
import { FirstRun, firstRunDismissed } from './FirstRun.js';

const DEFAULT_MODEL = 'gemma-2-2b-it';
const DEFAULT_PROMPT = 'The capital of France is';

// Default contrast pair for activation patching: GPT-2's canonical IOI task.
// Clean predicts " Mary" (the indirect object); the corrupted prompt swaps the
// subject so the answer becomes " John". Only ONE token differs, so the two
// prompts stay token-aligned for position-by-position patching.
const DEFAULT_CLEAN = 'When Mary and John went to the store, John gave a drink to';
const DEFAULT_CORRUPT = 'When Mary and John went to the store, Mary gave a drink to';
const DEFAULT_ANSWER = ' Mary';
const DEFAULT_CORRUPT_ANSWER = ' John';

type Props = {
  /** Called when a probe completes — the canvas opens the result card. */
  onResult: (run: ProbeRun) => void;
};

export function Toolchest({ onResult }: Props) {
  const loadedQuery = useQuery({
    queryKey: ['mi-loaded'],
    queryFn: getLoadedModels,
    retry: false,
    refetchInterval: 5_000,
  });
  const modelId = loadedQuery.data?.loaded?.[0] ?? DEFAULT_MODEL;

  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [layer, setLayer] = useState(6);
  const [head, setHead] = useState(0);
  const [topK, setTopK] = useState(10);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Contrast pair — only used by activation patching.
  const [cleanPrompt, setCleanPrompt] = useState(DEFAULT_CLEAN);
  const [corruptedPrompt, setCorruptedPrompt] = useState(DEFAULT_CORRUPT);
  const [answer, setAnswer] = useState(DEFAULT_ANSWER);
  const [corruptedAnswer, setCorruptedAnswer] = useState(DEFAULT_CORRUPT_ANSWER);
  const [showContrast, setShowContrast] = useState(false);
  const [filling, setFilling] = useState(false);

  // Instrument self-test (canary).
  const [canary, setCanary] = useState<CanaryResponse | null>(null);
  const [canaryRunning, setCanaryRunning] = useState(false);

  // First-run intro: shown until completed (step 3) or skipped.
  const [introDismissed, setIntroDismissed] = useState(firstRunDismissed);
  const modelLoaded = (loadedQuery.data?.loaded?.length ?? 0) > 0;

  async function runProbe(probe: ProbeDefinition) {
    setRunningId(probe.id);
    setError(null);
    setNotice(null);

    // Long-op honesty: the first J-lens probe on a model builds its Jacobian
    // (a minute or more, then cached). Say so BEFORE the wait, not after.
    if (probe.viz === 'model-diff') {
      setNotice(
        'Model diff compares against distilgpt2. The first run downloads it (~350 MB, once).',
      );
    }
    if (probe.viz === 'jlens-grid' || probe.viz === 'jlens-swap') {
      try {
        const ready = await getJlensReady(modelId);
        if (!ready.warm) {
          setNotice(
            `First J-lens run on ${modelId}: computing its Jacobian over the averaging corpus — up to a couple of minutes, cached after.`,
          );
        }
      } catch {
        // warmth check is best-effort
      }
    }
    const isPatch = probe.viz === 'patch-heatmap';
    const params = {
      layer,
      head,
      top_k: topK,
      // For patching, the header should restate the clean prompt.
      prompt: isPatch ? cleanPrompt : prompt,
      clean_prompt: cleanPrompt,
      corrupted_prompt: corruptedPrompt,
      answer,
      corrupted_answer: corruptedAnswer,
    };
    try {
      const result = await callBackend(probe, modelId, params);
      onResult({ probe, params, result });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'probe failed');
    } finally {
      setRunningId(null);
      setNotice(null);
    }
  }

  // Seed the contrast pair from the model's actual top-2 next tokens for the
  // current prompt — so patching / attribution start from a meaningful,
  // prompt-relevant pair instead of a stale default.
  async function fillContrastFromModel() {
    setFilling(true);
    try {
      const res = await nextTokens({ model_id: modelId, prompt });
      const [a, b] = res.top_tokens;
      if (a) setAnswer(a.token);
      if (b) setCorruptedAnswer(b.token);
    } catch {
      // Non-fatal — leave the fields as they are.
    } finally {
      setFilling(false);
    }
  }

  // Instrument self-test — prove the probes aren't silently lying before you
  // trust a result (the safeguard the logit-lens bug proved we needed).
  async function runInstrumentCanary() {
    setCanaryRunning(true);
    try {
      setCanary(await runCanary(modelId));
    } catch {
      setCanary(null);
    } finally {
      setCanaryRunning(false);
    }
  }

  const categories: ProbeCategory[] = ['inspection', 'intervention', 'features', 'sae', 'circuits'];

  if (!introDismissed) {
    const attentionProbe = PROBES.find((p) => p.id === 'attention-pattern');
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <FirstRun
          modelLoaded={modelLoaded}
          onFirstProbe={() => {
            if (attentionProbe) void runProbe(attentionProbe);
          }}
          onDismiss={() => setIntroDismissed(true)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Shared controls */}
      <div className="border-line space-y-2 border-b px-3 py-3">
        <label className="text-dim block text-[10px] uppercase tracking-[0.18em]">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          className="border-line bg-obsidian text-text focus:border-accent/50 w-full resize-none rounded border px-2 py-1.5 text-xs outline-none transition-colors"
          placeholder="Text to run through the model…"
        />
        <div className="grid grid-cols-3 gap-2">
          <NumField label="Layer" value={layer} onChange={setLayer} min={0} />
          <NumField label="Head" value={head} onChange={setHead} min={0} />
          <NumField label="Top-k" value={topK} onChange={setTopK} min={1} max={50} />
        </div>
        <div className="text-dim text-[10px]">
          target <span className="text-text font-mono">{modelId}</span>
        </div>

        {/* Instrument self-test (canary): prove the probes aren't lying. */}
        <div className="border-line overflow-hidden rounded border">
          <button
            type="button"
            onClick={() => void runInstrumentCanary()}
            disabled={canaryRunning}
            className="flex w-full items-center justify-between px-2 py-1 text-[10px] disabled:opacity-50"
          >
            <span className="text-dim uppercase tracking-[0.15em]">Instrument</span>
            {canary ? (
              <span
                className={
                  canary.verdict === 'verified'
                    ? 'text-success'
                    : canary.verdict === 'suspect'
                      ? 'text-accent-warm'
                      : 'text-dim'
                }
              >
                {canary.verdict === 'verified'
                  ? '✓ verified'
                  : canary.verdict === 'suspect'
                    ? '⚠ suspect'
                    : `— ${canary.verdict}`}
              </span>
            ) : (
              <span className="text-dim">{canaryRunning ? 'checking…' : 'verify ↻'}</span>
            )}
          </button>
          {canary && (
            <div className="border-line space-y-0.5 border-t px-2 py-1">
              {canary.checks.map((c) => (
                <div key={c.name} className="flex items-start gap-1.5 text-[9px] leading-snug">
                  <span className={c.passed ? 'text-success' : 'text-accent-warm'}>
                    {c.passed ? '✓' : '✕'}
                  </span>
                  <span className="text-dim">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Contrast pair — only read by activation patching. Collapsed by
            default so the common single-prompt probes stay uncluttered. */}
        <details
          open={showContrast}
          onToggle={(e) => setShowContrast((e.currentTarget as HTMLDetailsElement).open)}
          className="border-line rounded border"
        >
          <summary className="text-dim cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-[0.15em]">
            Contrast pair · for patching
          </summary>
          <div className="space-y-1.5 px-2 pb-2">
            <ContrastField label="Clean prompt" value={cleanPrompt} onChange={setCleanPrompt} />
            <ContrastField
              label="Corrupted prompt"
              value={corruptedPrompt}
              onChange={setCorruptedPrompt}
            />
            <div className="grid grid-cols-2 gap-2">
              <ContrastField label="Answer" value={answer} onChange={setAnswer} mono />
              <ContrastField
                label="vs."
                value={corruptedAnswer}
                onChange={setCorruptedAnswer}
                mono
              />
            </div>
            <button
              type="button"
              onClick={() => void fillContrastFromModel()}
              disabled={filling}
              className="border-line text-accent hover:border-accent/50 w-full rounded border px-2 py-1 text-[10px] transition-colors disabled:opacity-50"
            >
              {filling ? 'asking the model…' : `↺ fill from ${modelId}’s top guesses`}
            </button>
            <p className="text-dim/70 text-[9px] leading-snug">
              For patching, change ONE word between the clean and corrupted prompts. For
              attribution, Answer vs. vs. are the two words you compare. A leading space is added
              automatically; the button fills both from the model’s actual top-2 next words for your
              prompt.
            </p>
          </div>
        </details>
      </div>

      {/* Probe buttons by intent group */}
      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {error && (
          <div className="border-warn/30 bg-warn/5 text-warn rounded border px-2 py-1.5 text-[11px]">
            {error}
          </div>
        )}
        {notice && (
          <div className="border-accent-soft/30 bg-accent-soft/5 text-accent-soft rounded border px-2 py-1.5 text-[11px] leading-snug">
            {notice}
          </div>
        )}
        {categories.map((cat) => {
          const probes = PROBES_BY_CATEGORY[cat];
          if (probes.length === 0) {
            return <ComingSoon key={cat} label={CATEGORY_LABELS[cat]} />;
          }
          return (
            <div key={cat}>
              <div className="text-dim mb-1.5 text-[10px] uppercase tracking-[0.18em]">
                {CATEGORY_LABELS[cat]}
              </div>
              <div className="space-y-1.5">
                {probes.map((probe) => (
                  <ProbeButton
                    key={probe.id}
                    probe={probe}
                    running={runningId === probe.id}
                    onClick={() => void runProbe(probe)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProbeButton({
  probe,
  running,
  onClick,
}: {
  probe: ProbeDefinition;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      title={probe.concept}
      className="border-line bg-panel hover:border-accent-soft/50 hover:bg-panel-2 group flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition disabled:cursor-wait"
    >
      <span className="bg-accent-soft/10 text-accent-soft mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
        {running ? (
          <CircleNotch size={14} weight="bold" className="animate-spin" />
        ) : (
          <probe.icon size={14} weight="duotone" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-text block text-[12px] font-medium leading-snug">{probe.intent}</span>
        <span className="text-dim block text-[10px]">{probe.shortLabel}</span>
      </span>
    </button>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div>
      <div className="text-dim mb-1.5 text-[10px] uppercase tracking-[0.18em]">{label}</div>
      <div className="border-line text-dim/60 rounded-lg border border-dashed px-2.5 py-2 text-[11px]">
        coming soon
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block">
      <span className="text-dim mb-0.5 block text-[9px] uppercase tracking-[0.15em]">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="border-line bg-obsidian text-text focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-xs outline-none transition-colors"
      />
    </label>
  );
}

function ContrastField({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-dim mb-0.5 block text-[9px] uppercase tracking-[0.15em]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={[
          'border-line bg-obsidian text-text focus:border-accent/50 w-full rounded border px-2 py-1 text-xs outline-none transition-colors',
          mono ? 'font-mono' : '',
        ].join(' ')}
      />
    </label>
  );
}

// ---------- backend dispatch ------------------------------------------------

async function callBackend(
  probe: ProbeDefinition,
  modelId: string,
  params: {
    layer: number;
    head: number;
    top_k: number;
    prompt: string;
    clean_prompt?: string;
    corrupted_prompt?: string;
    answer?: string;
    corrupted_answer?: string;
  },
): Promise<ProbeResult> {
  if (probe.viz === 'attention-heatmap') {
    const data = await getAttentionPattern({
      model_id: modelId,
      prompt: params.prompt,
      layer: params.layer,
      head: params.head,
    });
    return { kind: 'attention-heatmap', data };
  }
  if (probe.viz === 'token-bars') {
    const data = await getActivations({
      model_id: modelId,
      prompt: params.prompt,
      layer: params.layer,
      site: 'resid_post',
    });
    return { kind: 'token-bars', data };
  }
  if (probe.viz === 'ablation-compare') {
    const data = await ablateHead({
      model_id: modelId,
      prompt: params.prompt,
      layer: params.layer,
      head: params.head,
      top_k: params.top_k,
    });
    return { kind: 'ablation-compare', data };
  }
  if (probe.viz === 'head-sweep') {
    const data = await ablateSweep({ model_id: modelId, prompt: params.prompt });
    return { kind: 'head-sweep', data };
  }
  if (probe.viz === 'patch-heatmap') {
    const data = await patchActivations({
      model_id: modelId,
      clean_prompt: params.clean_prompt ?? params.prompt,
      corrupted_prompt: params.corrupted_prompt ?? params.prompt,
      answer: params.answer ?? '',
      corrupted_answer: params.corrupted_answer ?? '',
    });
    return { kind: 'patch-heatmap', data };
  }
  if (probe.viz === 'attribution-heatmap') {
    const data = await logitAttribution({
      model_id: modelId,
      prompt: params.prompt,
      answer: params.answer ?? '',
      corrupted_answer: params.corrupted_answer ?? '',
    });
    return { kind: 'attribution-heatmap', data };
  }
  if (probe.viz === 'neuron-list') {
    const data = await getNeurons({
      model_id: modelId,
      prompt: params.prompt,
      layer: params.layer,
      top_k: params.top_k,
    });
    return { kind: 'neuron-list', data };
  }
  if (probe.viz === 'jlens-grid') {
    const data = await getJlens({ model_id: modelId, prompt: params.prompt });
    return { kind: 'jlens-grid', data };
  }
  if (probe.viz === 'token-heat-surprisal') {
    const data = await getSurprisal({ model_id: modelId, prompt: params.prompt });
    return { kind: 'token-heat-surprisal', data };
  }
  if (probe.viz === 'token-heat-unit') {
    // The shared "Head" control doubles as the unit number for this probe.
    const data = await getUnitActivation({
      model_id: modelId,
      prompt: params.prompt,
      layer: params.layer,
      unit: params.head,
    });
    return { kind: 'token-heat-unit', data };
  }
  if (probe.viz === 'generation-trace') {
    const data = await getGenerateTrace({
      model_id: modelId,
      prompt: params.prompt,
      top_k: params.top_k,
    });
    return { kind: 'generation-trace', data };
  }
  if (probe.viz === 'max-activating') {
    const data = await getMaxActivating({
      model_id: modelId,
      layer: params.layer,
      unit: params.head,
      top_k: params.top_k,
    });
    return { kind: 'max-activating', data };
  }
  if (probe.viz === 'model-diff') {
    const data = await getModelDiff({
      model_id: modelId,
      prompt: params.prompt,
      top_k: params.top_k,
    });
    return { kind: 'model-diff', data };
  }
  if (probe.viz === 'tokenizer') {
    const data = await getTokenize({ model_id: modelId, prompt: params.prompt });
    return { kind: 'tokenizer', data };
  }
  if (probe.viz === 'token-heat-saliency') {
    // Optional Answer field = the target token; empty -> model's own top-1.
    const data = await getSaliency({
      model_id: modelId,
      prompt: params.prompt,
      answer: (params.answer ?? '').trim() || undefined,
    });
    return { kind: 'token-heat-saliency', data };
  }
  if (probe.viz === 'weight-lens') {
    const data = await getWeightLens({
      model_id: modelId,
      layer: params.layer,
      unit: params.head,
      top_k: params.top_k,
    });
    return { kind: 'weight-lens', data };
  }
  if (probe.viz === 'head-census') {
    const data = await getHeadCensus(modelId);
    return { kind: 'head-census', data };
  }
  if (probe.viz === 'sae-feature-list') {
    const data = await getSaeFeatures({
      model_id: 'gpt2',
      prompt: params.prompt,
      layer: params.layer,
      top_k: params.top_k,
    });
    return { kind: 'sae-feature-list', data };
  }
  if (probe.viz === 'sae-ablate') {
    // The shared "Head" control doubles as the feature number for this probe.
    const data = await saeAblateFeature({
      model_id: 'gpt2',
      prompt: params.prompt,
      layer: params.layer,
      feature: params.head,
      top_k: params.top_k,
    });
    return { kind: 'sae-ablate', data };
  }
  if (probe.viz === 'jlens-swap') {
    // Answer field = the thought currently in the workspace; vs. = the swap-in.
    const data = await jlensSwap({
      model_id: modelId,
      prompt: params.prompt,
      source: (params.answer ?? '').trim(),
      target: (params.corrupted_answer ?? '').trim(),
    });
    return { kind: 'jlens-swap', data };
  }
  if (probe.viz === 'direction-curve') {
    // Reuses the contrast-pair fields as example sets: several examples can be
    // separated with | in each field.
    const split = (s: string) =>
      s
        .split('|')
        .map((t) => t.trim())
        .filter(Boolean);
    const data = await getConceptDirection({
      model_id: modelId,
      prompt: params.prompt,
      pos_prompts: split(params.clean_prompt ?? ''),
      neg_prompts: split(params.corrupted_prompt ?? ''),
    });
    return { kind: 'direction-curve', data };
  }
  const data = await getLogitLens({
    model_id: modelId,
    prompt: params.prompt,
    layer: params.layer,
    top_k: params.top_k,
  });
  return { kind: 'logit-list', data };
}
