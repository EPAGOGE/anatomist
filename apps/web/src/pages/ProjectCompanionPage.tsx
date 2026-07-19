// Project companion page — F-0 Criterion 7 (per ADR-0037).
//
// A view over existing chain data. The user opens this when they
// come back to a project; the companion's job is orientation — show
// "where you were" so they resume instead of reconstructing.
//
// Sections (per the build doc task 102):
//   - Overview: current name, description, lifecycle, creation event
//   - Decision log: architecture saves derived from the chain
//   - Lifecycle moves between positions (planned; minimal in F-0)
//   - "Ask the AI" prompt that hops to the chat scoped to this project
//
// Per ADR-0037 the companion does NOT capture new decisions. The
// reasoning-capture events already exist; we just surface them.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Lightbulb,
  Graph,
  ChatsCircle,
  CaretRight,
  ArrowLeft,
  CircleNotch,
} from '@phosphor-icons/react';
import {
  getProjectCompanion,
  updateProjectLifecycle,
  type LifecyclePosition,
  type CompanionDecisionRow,
} from '../api/endpoints.js';
import { useProjectStore } from '../projects/store.js';
import { truncateHash } from '../util/format.js';

const LIFECYCLE_OPTIONS: readonly LifecyclePosition[] = [
  'data',
  'architecture',
  'training',
  'evaluation',
  'deployment',
];

const LIFECYCLE_LABELS: Record<LifecyclePosition, string> = {
  data: 'Data',
  architecture: 'Architecture',
  training: 'Training',
  evaluation: 'Evaluation',
  deployment: 'Deployment',
};

export function ProjectCompanionPage() {
  const { project_id } = useParams<{ project_id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSelected = useProjectStore((s) => s.setSelectedProjectId);

  const query = useQuery({
    queryKey: ['project-companion', project_id],
    queryFn: () => getProjectCompanion(project_id!),
    enabled: !!project_id,
  });

  const lifecycleMutation = useMutation({
    mutationFn: async (newPos: LifecyclePosition) => updateProjectLifecycle(project_id!, newPos),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-companion', project_id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['chain-ribbon'] });
    },
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-neutral-500">
        <CircleNotch size={12} weight="bold" className="animate-spin" />
        loading companion…
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="space-y-3">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-xs text-neutral-500 transition hover:text-neutral-300"
        >
          <ArrowLeft size={11} weight="bold" />
          Back to projects
        </Link>
        <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {query.error instanceof Error ? query.error.message : 'could not load project'}
        </div>
      </div>
    );
  }

  const { project, decision_log } = query.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-neutral-500 transition hover:text-neutral-300"
        >
          <ArrowLeft size={11} weight="bold" />
          Projects
        </Link>
        <span className="text-neutral-700">/</span>
        <span className="text-neutral-300">{project.name}</span>
      </div>

      <header className="rounded-lg border border-neutral-800 bg-neutral-950/60 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold text-neutral-100">{project.name}</h1>
          <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
            {LIFECYCLE_LABELS[project.lifecycle_position]}
          </span>
        </div>
        {project.description && (
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">{project.description}</p>
        )}
        <div className="mt-2 flex items-center gap-3 text-[10px] text-neutral-600">
          <span title={`Created ${project.created_at}`}>
            opened {formatRelative(project.created_at)}
          </span>
          {project.creation_event_hash && (
            <span className="font-mono" title={`Creation event: ${project.creation_event_hash}`}>
              event {truncateHash(project.creation_event_hash)}
            </span>
          )}
        </div>
      </header>

      <section className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <Graph size={13} weight="duotone" className="text-emerald-400" />
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-300">
            Lifecycle
          </span>
          {lifecycleMutation.isPending && (
            <CircleNotch size={11} weight="bold" className="animate-spin text-neutral-500" />
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {LIFECYCLE_OPTIONS.map((opt) => {
            const active = opt === project.lifecycle_position;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  if (!active) lifecycleMutation.mutate(opt);
                }}
                disabled={active || lifecycleMutation.isPending}
                className={`rounded px-2 py-1 text-[10px] font-medium transition ${
                  active
                    ? 'bg-emerald-900/40 text-emerald-200 ring-1 ring-emerald-700/60'
                    : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                }`}
              >
                {LIFECYCLE_LABELS[opt]}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] leading-snug text-neutral-600">
          Move the marker as your work progresses. Each move lands as a signed event on your chain.
        </p>
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <Lightbulb size={13} weight="duotone" className="text-amber-300" />
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-300">
            Decision log
          </span>
          <span className="text-[10px] text-neutral-600">
            {decision_log.length} {decision_log.length === 1 ? 'save' : 'saves'} on chain
          </span>
        </div>
        {decision_log.length === 0 ? (
          <p className="text-xs text-neutral-500">
            No architecture saves yet for this project.{' '}
            <button
              type="button"
              onClick={() => {
                setSelected(project.project_id);
                navigate('/');
              }}
              className="text-emerald-300 transition hover:text-emerald-200"
            >
              Open the canvas
            </button>{' '}
            to compose your first one.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {decision_log.map((row) => (
              <DecisionRow key={row.architecture_event_hash} row={row} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <ChatsCircle size={13} weight="duotone" className="text-violet-300" />
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-300">
            Ask the AI
          </span>
        </div>
        <p className="text-xs leading-relaxed text-neutral-400">
          The AI knows about this project — the architecture you composed, the decisions you've
          made, the lifecycle you're in. Your next question will be answered grounded in that work
          rather than generically.
        </p>
        <button
          type="button"
          onClick={() => {
            setSelected(project.project_id);
            navigate('/chat');
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-white"
        >
          Open chat in this project
          <CaretRight size={11} weight="bold" />
        </button>
      </section>
    </div>
  );
}

function DecisionRow({ row }: { row: CompanionDecisionRow }) {
  return (
    <li>
      <Link
        to={`/architectures/${row.architecture_event_hash}`}
        className="flex items-center gap-3 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 transition hover:border-neutral-600 hover:bg-neutral-900"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-neutral-100">{row.name}</span>
            <span className="font-mono text-[10px] text-neutral-500">
              #{row.causal_sequence_marker}
            </span>
          </div>
          {row.description && (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-neutral-500">
              {row.description}
            </p>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-600">
            <span>{formatRelative(row.occurred_at)}</span>
            <span className="font-mono" title={row.architecture_event_hash}>
              event {truncateHash(row.architecture_event_hash)}
            </span>
            <span className="font-mono">
              {row.node_count}n · {row.edge_count}e
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}

// Render a timestamp as "5m ago", "2h ago", "3d ago", "Apr 14".
// Tiny helper — same UX hint as the chain ribbon's time display.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const delta = Date.now() - then;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
