// Validation panel — Phase 0 sub-phase E, tranche E5.
//
// Right-pane tab alongside Inspector and Code. Two-tier display:
//
//   Tier 1 (deterministic): run the validator against the current
//   graph immediately, render each error as a one-line description.
//   This is the source of truth for whether the architecture is valid.
//
//   Tier 2 (AI-assisted): per error, an "Explain" affordance triggers
//   a server call that invokes the AI orchestrator with grounded
//   context and returns a prose explanation + suggested fixes. The
//   explanation lands as an ai-interaction chain event.
//
// The panel respects the ADR-0032 boundary: the deterministic result
// is what determines validity. The AI explanation is assistance only.

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  CheckCircle,
  WarningCircle,
  Sparkle,
  CircleNotch,
  Cube,
  type Icon,
} from '@phosphor-icons/react';
import {
  validateGraph,
  formatError,
  errorFingerprint,
  type ComponentRegistry,
  type GraphSpec,
  type ValidationError,
} from '@epagoge/components';
import { explainArchitectureError } from '../api/endpoints.js';
import type { ApiError } from '../api/client.js';

export interface ValidationPanelProps {
  readonly graph: GraphSpec | null;
  readonly registry: ComponentRegistry;
}

interface ExplanationState {
  readonly text: string;
  readonly costNanos: string;
  readonly fromCache: boolean;
  readonly tier: 'haiku' | 'sonnet' | 'opus';
}

export function ValidationPanel({ graph, registry }: ValidationPanelProps) {
  const result = useMemo(() => {
    if (!graph) return { valid: true, errors: [] as readonly ValidationError[] };
    return validateGraph(graph, registry);
  }, [graph, registry]);

  // Per-fingerprint explanation cache. Once the user clicks "Explain"
  // and the server returns, we keep the explanation on screen so they
  // can switch tabs and come back.
  const [explanations, setExplanations] = useState<Record<string, ExplanationState>>({});

  const explain = useMutation({
    mutationFn: async (input: { error: ValidationError; graph: GraphSpec }) => {
      const fingerprint = errorFingerprint(input.error);
      const res = await explainArchitectureError({
        name: input.graph.name,
        ...(input.graph.description !== undefined ? { description: input.graph.description } : {}),
        nodes: input.graph.nodes.map((n) => ({ ...n })),
        edges: input.graph.edges.map((e) => ({ ...e })),
        fingerprint,
      });
      return { ...res, fingerprint };
    },
    onSuccess: (res) => {
      setExplanations((prev) => ({
        ...prev,
        [res.fingerprint]: {
          text: res.explanation,
          costNanos: res.cost_nanos,
          fromCache: res.from_cache,
          tier: res.tier,
        },
      }));
    },
  });

  if (!graph || graph.nodes.length === 0) {
    return (
      <EmptyState
        icon={Cube}
        title="No architecture yet"
        body="Drop components on the canvas to start composing. Validation will run as you connect them."
      />
    );
  }

  if (result.valid) {
    return (
      <div className="flex h-full flex-col">
        <Header errorCount={0} />
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <div className="relative">
            <CheckCircle size={36} weight="duotone" className="text-success" />
            <div
              className="bg-success/20 absolute inset-0 -z-10 rounded-full blur-xl"
              aria-hidden
            />
          </div>
          <div className="text-text text-sm font-medium">Architecture valid</div>
          <div className="text-dim text-xs leading-relaxed">
            {graph.nodes.length} nodes, {graph.edges.length} edges. All shape, dtype, and
            divisibility constraints satisfied; graph is acyclic; all nodes reachable.
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header errorCount={result.errors.length} />
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {result.errors.map((err) => {
          const fp = errorFingerprint(err);
          const exp = explanations[fp];
          const isExplaining =
            explain.isPending &&
            explain.variables?.error &&
            errorFingerprint(explain.variables.error) === fp;
          const lastError =
            explain.error && explain.variables && errorFingerprint(explain.variables.error) === fp
              ? ((explain.error as unknown as ApiError).message ?? 'explain failed')
              : null;
          return (
            <ErrorCard
              key={
                fp +
                ':' +
                ((err as { edgeId?: string }).edgeId ?? (err as { nodeId?: string }).nodeId ?? fp)
              }
              error={err}
              explanation={exp}
              isExplaining={isExplaining}
              errorMessage={lastError}
              onExplain={() => {
                if (graph) explain.mutate({ error: err, graph });
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function Header({ errorCount }: { errorCount: number }) {
  return (
    <div className="border-line bg-panel flex items-center gap-2 border-b px-3 py-2 text-xs">
      {errorCount === 0 ? (
        <CheckCircle size={14} weight="duotone" className="text-success" />
      ) : (
        <WarningCircle size={14} weight="duotone" className="text-accent-warm" />
      )}
      <span className="text-text">
        {errorCount === 0 ? 'No issues' : `${errorCount} issue${errorCount === 1 ? '' : 's'}`}
      </span>
      <span className="text-dim ml-auto text-[10px] uppercase tracking-[0.18em]">
        deterministic
      </span>
    </div>
  );
}

function ErrorCard({
  error,
  explanation,
  isExplaining,
  errorMessage,
  onExplain,
}: {
  error: ValidationError;
  explanation: ExplanationState | undefined;
  isExplaining: boolean;
  errorMessage: string | null;
  onExplain: () => void;
}) {
  const summary = formatError(error);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      className="border-accent-warm/30 bg-accent-warm/5 rounded-lg border p-2.5"
    >
      <div className="flex items-start gap-2">
        <WarningCircle size={14} weight="duotone" className="text-accent-warm mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-accent-warm text-[10px] uppercase tracking-[0.15em]">
            {error.code.replace(/-/g, ' ')}
          </div>
          <div className="text-text mt-0.5 break-words text-xs leading-snug">{summary}</div>
        </div>
      </div>

      <div className="border-line mt-2 flex items-center gap-2 border-t pt-2">
        {!explanation && !isExplaining && (
          <button
            type="button"
            onClick={onExplain}
            className="border-accent-soft/40 bg-accent-soft/10 text-accent-soft hover:border-accent-soft/70 hover:bg-accent-soft/15 inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors"
            title="Ask AI to explain this error and suggest fixes"
          >
            <Sparkle size={11} weight="duotone" />
            Explain
          </button>
        )}
        {isExplaining && (
          <div className="text-accent-soft inline-flex items-center gap-1.5 text-[10px]">
            <CircleNotch size={11} weight="bold" className="animate-spin" />
            <span>asking AI…</span>
          </div>
        )}
        {explanation && (
          <div className="text-dim text-[10px]">
            via {explanation.tier}
            {explanation.fromCache && <span className="text-success ml-1">· cached</span>}
            {!explanation.fromCache && (
              <span className="ml-1">· {formatCostNanos(explanation.costNanos)}</span>
            )}
          </div>
        )}
      </div>

      {errorMessage && (
        <div className="border-warn/40 bg-warn/10 text-warn mt-2 rounded border px-2 py-1 text-[10px]">
          {errorMessage}
        </div>
      )}

      {explanation && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="glass mt-2 rounded-md p-2.5 text-xs leading-relaxed"
        >
          <TypewriterReveal text={explanation.text} />
        </motion.div>
      )}
    </motion.div>
  );
}

/**
 * Word-by-word reveal of AI explanation text. Each word fades in with a
 * small stagger delay — gives the "AI is thinking through this with you"
 * feel without doing per-character animation (which feels gimmicky at
 * explanation-length).
 *
 * Stagger is gentle (28ms per word) so a 50-word explanation completes
 * in ~1.4s — long enough to feel deliberate, short enough that the user
 * doesn't have to wait.
 */
function TypewriterReveal({ text }: { text: string }) {
  // Split on whitespace but keep the spaces in output so layout stays
  // honest. Use \n as paragraph separators with extra weight.
  const lines = text.split('\n');
  let wordIndex = 0;
  return (
    <div className="text-text">
      {lines.map((line, lineIdx) => (
        <div key={lineIdx} className={lineIdx > 0 ? 'mt-2' : ''}>
          {line.split(/(\s+)/).map((token, tokenIdx) => {
            if (/^\s+$/.test(token)) return <span key={tokenIdx}>{token}</span>;
            const idx = wordIndex++;
            return (
              <motion.span
                key={tokenIdx}
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: idx * 0.028, ease: 'easeOut' }}
              >
                {token}
              </motion.span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon: IconCmp, title, body }: { icon: Icon; title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <IconCmp size={28} weight="duotone" className="text-dim" />
      <div className="text-text text-sm font-medium">{title}</div>
      <div className="text-dim text-xs leading-relaxed">{body}</div>
    </div>
  );
}

function formatCostNanos(nanos: string): string {
  const n = BigInt(nanos);
  if (n === 0n) return 'free';
  // 1 USD = 1e9 nano-USD. Show in millicents for small explanations.
  const millicents = Number(n) / 1_000_0; // nanos / 10000 = millicents
  if (millicents < 1) return `${(Number(n) / 1000).toFixed(1)} µ$`;
  return `${millicents.toFixed(2)} mcent`;
}
