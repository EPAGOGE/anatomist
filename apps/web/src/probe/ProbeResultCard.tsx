// ProbeResultCard — the learning-layer FOLD (see docs/Learning_Layer.md).
//
// One card, four representations of the same operation, in order:
//   1. SEEING   — the visualization (heatmap / bars / ranked list)
//   2. PROCESS  — what just happened, in plain language
//   3. MATH     — the operation in notation
//   4. CODE     — the Python that ran, filled with the user's params
//
// The fold: the same CONCEPTS (query, key, softmax, …) are highlighted the
// same way across process, math, and code. Hover a concept chip to read its
// gloss and see it light up everywhere it appears. That shared marking is
// what lets the user trace one idea from plain words → notation → code, so
// the mapping between "what I wanted," "what I see," "the math," and "the
// code" builds itself.

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowsOutSimple, Copy, DownloadSimple, WarningCircle, X } from '@phosphor-icons/react';
import { downloadScript } from './export-script.js';
import { CONCEPTS, fillTemplate, type ProbeDefinition } from './toolchest-catalog.js';
import { AttentionHeatmap } from './viz/AttentionHeatmap.js';
import { TokenBars } from './viz/TokenBars.js';
import { LogitList } from './viz/LogitList.js';
import { AblationCompare } from './viz/AblationCompare.js';
import { HeadSweepGrid } from './viz/HeadSweepGrid.js';
import { PatchHeatmap } from './viz/PatchHeatmap.js';
import { AttributionHeatmap } from './viz/AttributionHeatmap.js';
import { NeuronList } from './viz/NeuronList.js';
import { DirectionCurve } from './viz/DirectionCurve.js';
import { JlensGrid } from './viz/JlensGrid.js';
import { SwapCompare } from './viz/SwapCompare.js';
import { SaeFeatureList } from './viz/SaeFeatureList.js';
import { TokenHeat } from './viz/TokenHeat.js';
import { GenerationTrace } from './viz/GenerationTrace.js';
import type {
  AttentionPatternResponse,
  ActivationsResponse,
  LogitLensResponse,
  AblateHeadResponse,
  AblateSweepResponse,
  PatchResponse,
  AttributionResponse,
  NeuronFiringsResponse,
  ConceptDirectionResponse,
  JlensResponse,
  JlensSwapResponse,
  SurprisalResponse,
  UnitActivationResponse,
  GenerateTraceResponse,
  TokenizeResponse,
  HeadCensusResponse,
  SaliencyResponse,
  WeightLensResponse,
  MaxActivatingResponse,
  ModelDiffResponse,
} from '../api/mi-endpoints.js';
import { TokenizerView } from './viz/TokenizerView.js';
import { HeadCensus } from './viz/HeadCensus.js';
import { WeightLens } from './viz/WeightLens.js';
import { MaxActivatingView } from './viz/MaxActivatingView.js';
import { ModelDiffView } from './viz/ModelDiffView.js';
import type { SaeAblateResponse, SaeFeaturesResponse } from '../api/sae-endpoints.js';

export type ProbeResult =
  | { kind: 'attention-heatmap'; data: AttentionPatternResponse }
  | { kind: 'token-bars'; data: ActivationsResponse }
  | { kind: 'logit-list'; data: LogitLensResponse }
  | { kind: 'ablation-compare'; data: AblateHeadResponse }
  | { kind: 'head-sweep'; data: AblateSweepResponse }
  | { kind: 'patch-heatmap'; data: PatchResponse }
  | { kind: 'attribution-heatmap'; data: AttributionResponse }
  | { kind: 'neuron-list'; data: NeuronFiringsResponse }
  | { kind: 'direction-curve'; data: ConceptDirectionResponse }
  | { kind: 'jlens-grid'; data: JlensResponse }
  | { kind: 'jlens-swap'; data: JlensSwapResponse }
  | { kind: 'sae-feature-list'; data: SaeFeaturesResponse }
  | { kind: 'sae-ablate'; data: SaeAblateResponse }
  | { kind: 'token-heat-surprisal'; data: SurprisalResponse }
  | { kind: 'token-heat-unit'; data: UnitActivationResponse }
  | { kind: 'generation-trace'; data: GenerateTraceResponse }
  | { kind: 'tokenizer'; data: TokenizeResponse }
  | { kind: 'head-census'; data: HeadCensusResponse }
  | { kind: 'token-heat-saliency'; data: SaliencyResponse }
  | { kind: 'weight-lens'; data: WeightLensResponse }
  | { kind: 'max-activating'; data: MaxActivatingResponse }
  | { kind: 'model-diff'; data: ModelDiffResponse };

export type ProbeRun = {
  probe: ProbeDefinition;
  params: {
    layer: number;
    head: number;
    top_k: number;
    prompt: string;
    // Activation patching uses a contrast pair instead of layer/head.
    clean_prompt?: string;
    corrupted_prompt?: string;
    answer?: string;
    corrupted_answer?: string;
  };
  result: ProbeResult;
};

type Props = {
  run: ProbeRun;
  onClose: () => void;
};

export function ProbeResultCard({ run, onClose }: Props) {
  const { probe, params, result } = run;
  const [activeConcept, setActiveConcept] = useState<string | null>(null);

  const terms = useMemo(
    () => probe.concepts.map((id) => CONCEPTS[id]?.term).filter(Boolean) as string[],
    [probe],
  );
  const activeTerm = activeConcept ? (CONCEPTS[activeConcept]?.term ?? null) : null;

  const isStub = result.data.stub;
  const coords = coordsMeta(probe, params);

  return (
    <div className="glass flex max-h-[82vh] w-[clamp(360px,46vw,640px)] flex-col overflow-hidden rounded-2xl shadow-[0_24px_70px_rgba(0,0,0,0.6)]">
      {/* Intent header */}
      <div className="border-line flex items-start gap-3 border-b px-4 py-3">
        <div className="bg-accent/15 text-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <probe.icon size={18} weight="duotone" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-text text-sm font-semibold leading-snug">{probe.intent}</div>
          <div className="text-dim mt-0.5 font-mono text-[10px]">
            {[probe.shortLabel, coords, params.prompt ? `"${truncate(params.prompt, 48)}"` : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-dim hover:bg-panel-2 hover:text-text -mr-1 -mt-1 rounded p-1.5 transition"
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {isStub && <StubBanner note={result.data.note} />}

        {/* 1. SEEING */}
        <Section label="Seeing" icon={<ArrowsOutSimple size={11} weight="bold" />}>
          <Viz result={result} />
        </Section>

        {/* 2. PROCESS */}
        <Section label="What just happened">
          <p className="text-text text-[13px] leading-relaxed">
            {highlight(probe.process, terms, activeTerm)}
          </p>
        </Section>

        {/* 3. MATH */}
        <Section label="The math">
          <div className="border-line bg-obsidian/60 rounded-lg border px-3 py-2.5">
            <div className="text-text text-center font-mono text-base">
              {highlight(probe.math.expression, terms, activeTerm)}
            </div>
          </div>
          <p className="text-dim mt-2 text-[12px] leading-relaxed">
            {highlight(probe.math.note, terms, activeTerm)}
          </p>
        </Section>

        {/* 4. CODE */}
        <Section label="The code that ran">
          <CodeBlock
            code={fillTemplate(probe.codeTemplate, params)}
            terms={terms}
            activeTerm={activeTerm}
          />
          <button
            type="button"
            onClick={() => downloadScript(run, result.data.model_id)}
            className="border-line text-dim hover:text-text mt-2 flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] transition"
          >
            <DownloadSimple size={11} weight="bold" />
            Download as runnable script — reproduce this outside the workbench
          </button>
        </Section>

        {/* The fold: concept legend */}
        {probe.concepts.length > 0 && (
          <Section label="The thread">
            <div className="flex flex-wrap gap-1.5">
              {probe.concepts.map((id) => {
                const c = CONCEPTS[id];
                if (!c) return null;
                const active = activeConcept === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onMouseEnter={() => setActiveConcept(id)}
                    onMouseLeave={() => setActiveConcept(null)}
                    onFocus={() => setActiveConcept(id)}
                    onBlur={() => setActiveConcept(null)}
                    className={[
                      'rounded-full border px-2 py-0.5 text-[11px] transition',
                      active
                        ? 'border-accent-soft/70 bg-accent-soft/20 text-accent-soft'
                        : 'border-line bg-panel-2 text-dim hover:text-text',
                    ].join(' ')}
                    title={c.gloss}
                  >
                    {c.term}
                  </button>
                );
              })}
            </div>
            {activeConcept && CONCEPTS[activeConcept] && (
              <div className="mt-2 space-y-1">
                <p className="text-accent-soft text-[11px] leading-relaxed">
                  {CONCEPTS[activeConcept]!.gloss}
                </p>
                <p className="text-dim text-[11px] leading-relaxed">
                  {CONCEPTS[activeConcept]!.why}
                </p>
              </div>
            )}
            <p className="text-dim mt-2 text-[10px] leading-relaxed">
              Hover a term to see it light up in the words, the math, and the code — same idea,
              three languages.
            </p>
          </Section>
        )}
      </div>
    </div>
  );
}

// ---------- pieces ----------------------------------------------------------

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="text-dim mb-1.5 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em]">
        {icon}
        {label}
      </div>
      {children}
    </section>
  );
}

function Viz({ result }: { result: ProbeResult }) {
  if (result.kind === 'attention-heatmap') {
    return <AttentionHeatmap tokens={result.data.tokens} pattern={result.data.pattern} />;
  }
  if (result.kind === 'token-bars') {
    return <TokenBars tokens={result.data.tokens} norms={result.data.norms ?? []} />;
  }
  if (result.kind === 'ablation-compare') {
    return (
      <AblationCompare cleanTop={result.data.clean_top} ablatedTop={result.data.ablated_top} />
    );
  }
  if (result.kind === 'head-sweep') {
    return (
      <HeadSweepGrid
        nLayers={result.data.n_layers}
        nHeads={result.data.n_heads}
        grid={result.data.grid}
        topMovers={result.data.top_movers}
        cleanTopToken={result.data.clean_top_token}
      />
    );
  }
  if (result.kind === 'patch-heatmap') {
    return <PatchHeatmap data={result.data} />;
  }
  if (result.kind === 'attribution-heatmap') {
    return <AttributionHeatmap data={result.data} />;
  }
  if (result.kind === 'neuron-list') {
    return (
      <NeuronList
        firings={result.data.firings}
        layer={result.data.layer}
        dMlp={result.data.d_mlp}
      />
    );
  }
  if (result.kind === 'direction-curve') {
    return <DirectionCurve data={result.data} />;
  }
  if (result.kind === 'jlens-grid') {
    return <JlensGrid data={result.data} />;
  }
  if (result.kind === 'jlens-swap') {
    return <SwapCompare data={result.data} />;
  }
  if (result.kind === 'sae-feature-list') {
    return <SaeFeatureList data={result.data} />;
  }
  if (result.kind === 'sae-ablate') {
    return (
      <div>
        <p className="text-dim mb-2 text-[11px]">
          Knocked out feature <span className="text-text font-mono">f{result.data.feature}</span>{' '}
          (promotes: <span className="font-mono">{result.data.label_tokens.join(' ')}</span>)
        </p>
        <AblationCompare cleanTop={result.data.clean_top} ablatedTop={result.data.ablated_top} />
      </div>
    );
  }
  if (result.kind === 'token-heat-surprisal') {
    const d = result.data;
    return (
      <TokenHeat
        tokens={d.tokens.map((t) => ({
          token: t.token,
          value: t.surprisal,
          detail: [
            `p = ${(t.prob * 100).toFixed(1)}% · entropy ${t.entropy.toFixed(1)} bits`,
            ...(t.expected.length > 0 && t.expected[0]
              ? [`expected: ${t.expected[0].token} (${(t.expected[0].prob * 100).toFixed(0)}%)`]
              : []),
          ],
        }))}
        legend={`Red = surprised (bits of -log₂ p). Mean ${d.mean_surprisal.toFixed(1)} bits — hover any token for what the model expected instead.`}
      />
    );
  }
  if (result.kind === 'token-heat-unit') {
    const d = result.data;
    return (
      <TokenHeat
        tokens={d.tokens.map((tok, i) => ({ token: tok, value: d.activations[i] ?? 0 }))}
        legend={`L${d.layer} · unit ${d.unit} — warm = firing, blue = negative. Most units are boring; that's the lesson. Hunt with "Which neurons fire on this text".`}
      />
    );
  }
  if (result.kind === 'generation-trace') {
    return <GenerationTrace data={result.data} />;
  }
  if (result.kind === 'tokenizer') {
    return <TokenizerView data={result.data} />;
  }
  if (result.kind === 'head-census') {
    return <HeadCensus data={result.data} />;
  }
  if (result.kind === 'token-heat-saliency') {
    const d = result.data;
    return (
      <TokenHeat
        tokens={d.tokens.map((tok, i) => ({ token: tok, value: d.saliency[i] ?? 0 }))}
        legend={`Sensitivity of ${JSON.stringify(d.target)} to each input token (gradient norm). Hot = the answer leans on this token.`}
      />
    );
  }
  if (result.kind === 'weight-lens') {
    return <WeightLens data={result.data} />;
  }
  if (result.kind === 'max-activating') {
    return <MaxActivatingView data={result.data} />;
  }
  if (result.kind === 'model-diff') {
    return <ModelDiffView data={result.data} />;
  }
  return <LogitList topTokens={result.data.top_tokens} />;
}

function StubBanner({ note }: { note?: string | null }) {
  return (
    <div className="border-accent-warm/30 bg-accent-warm/5 text-accent-warm flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed">
      <WarningCircle size={13} weight="duotone" className="mt-0.5 shrink-0" />
      <span>
        Shape-only preview — the numbers below are placeholders, not real activations.
        {note ? ` (${note})` : ''} Install the ML deps and load the model to see real values.
      </span>
    </div>
  );
}

function CodeBlock({
  code,
  terms,
  activeTerm,
}: {
  code: string;
  terms: string[];
  activeTerm: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border-line bg-obsidian/70 relative rounded-lg border">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="text-dim hover:bg-panel-2 hover:text-text absolute right-2 top-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition"
      >
        <Copy size={10} weight="bold" />
        {copied ? 'copied' : 'copy'}
      </button>
      <pre className="text-text overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed">
        <code>{highlight(code, terms, activeTerm)}</code>
      </pre>
    </div>
  );
}

// ---------- term highlighting (the fold's visual thread) --------------------

/** Split `text` so every occurrence of any term (case-insensitive) is wrapped
 *  in a styled span. The active term gets a stronger highlight. */
function highlight(text: string, terms: string[], activeTerm: string | null): ReactNode {
  if (terms.length === 0) return text;
  // Longest terms first so multi-word terms ("residual stream") win over
  // their substrings.
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  return parts.map((part, i) => {
    const isTerm = sorted.some((t) => t.toLowerCase() === part.toLowerCase());
    if (!isTerm) return <span key={i}>{part}</span>;
    const isActive = activeTerm !== null && part.toLowerCase() === activeTerm.toLowerCase();
    return (
      <span
        key={i}
        className={[
          'rounded px-0.5 transition-colors',
          isActive ? 'bg-accent-soft/30 text-accent-soft' : 'text-accent-soft',
        ].join(' ')}
      >
        {part}
      </span>
    );
  });
}

// ---------- small utils -----------------------------------------------------

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Coordinate suffix for the header — only the controls this probe actually
 *  uses (a sweep uses neither layer nor head, so it returns ''). */
function coordsMeta(probe: ProbeDefinition, params: { layer: number; head: number }): string {
  const keys = new Set(probe.inputs.map((i) => i.key));
  const parts: string[] = [];
  if (keys.has('layer')) parts.push(`layer ${params.layer}`);
  if (keys.has('head')) parts.push(`head ${params.head}`);
  return parts.join(' · ');
}
