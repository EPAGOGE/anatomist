// Projects page — F-0 Criterion 1.
//
// The user's home for "starting work." Lists their projects with
// the current lifecycle position, exposes a create flow, and lets
// them set the active project (which scopes the canvas + chat + chain
// once Criteria 5 + 7 land).
//
// First-time arrival: an explanatory empty state encourages creating
// the first project. The chain ribbon at the bottom of the layout
// shows the project-created event land in real time — the platform's
// distinctive substrate becomes visible the moment the user does
// anything deliberate.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FolderPlus, CaretRight, CheckCircle, CircleNotch, X } from '@phosphor-icons/react';
import {
  createProject,
  listProjects,
  type CreateProjectRequest,
  type LifecyclePosition,
  type Project,
} from '../api/endpoints.js';
import type { ApiError } from '../api/client.js';
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

export function ProjectsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const projects = query.data?.projects ?? [];

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-neutral-100">Projects</h1>
        <span className="text-xs text-neutral-500">
          {projects.length} {projects.length === 1 ? 'project' : 'projects'}
        </span>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white"
        >
          <FolderPlus size={14} weight="duotone" />
          New project
        </button>
      </header>

      {query.isLoading && <div className="text-xs text-neutral-500">loading…</div>}

      {!query.isLoading && projects.length === 0 && (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      )}

      {projects.length > 0 && (
        <ul className="space-y-2">
          {projects.map((p) => (
            <ProjectRow key={p.project_id} project={p} />
          ))}
        </ul>
      )}

      {createOpen && (
        <CreateProjectDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950/60 px-6 py-12 text-center">
      <FolderPlus size={28} weight="duotone" className="text-neutral-600" />
      <div className="text-sm font-medium text-neutral-200">Start your first project</div>
      <p className="max-w-md text-xs leading-relaxed text-neutral-500">
        A project holds your architecture work — the canvas, the generated code, the chain of
        decisions. Creating one is your first action that lands as signed history on your chain.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white"
      >
        <FolderPlus size={13} weight="duotone" />
        Create project
      </button>
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const selectedId = useProjectStore((s) => s.selectedProjectId);
  const setSelected = useProjectStore((s) => s.setSelectedProjectId);
  const isSelected = selectedId === project.project_id;
  return (
    <li>
      <div
        className={`flex items-center gap-3 rounded border bg-neutral-950/60 px-3 py-2 ${
          isSelected ? 'border-emerald-700/60' : 'border-neutral-800'
        }`}
      >
        <button
          type="button"
          onClick={() => setSelected(isSelected ? null : project.project_id)}
          title={
            isSelected ? 'Active project, click to clear' : 'Click to make this the active project'
          }
          className={`h-3 w-3 shrink-0 rounded-full transition ${
            isSelected ? 'bg-emerald-500' : 'border border-neutral-600 hover:border-neutral-400'
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-neutral-100">{project.name}</span>
            <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
              {LIFECYCLE_LABELS[project.lifecycle_position]}
            </span>
          </div>
          {project.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-neutral-500">{project.description}</p>
          )}
          {project.creation_event_hash && (
            <div
              className="mt-0.5 font-mono text-[9px] text-neutral-600"
              title={`Creation event: ${project.creation_event_hash}`}
            >
              event {truncateHash(project.creation_event_hash)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Link
            to={`/projects/${project.project_id}`}
            className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100"
          >
            Companion
            <CaretRight size={10} weight="bold" />
          </Link>
          <Link
            to="/"
            onClick={() => setSelected(project.project_id)}
            className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100"
          >
            Open canvas
            <CaretRight size={10} weight="bold" />
          </Link>
        </div>
      </div>
    </li>
  );
}

function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const setSelected = useProjectStore((s) => s.setSelectedProjectId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lifecycle, setLifecycle] = useState<LifecyclePosition>('architecture');
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: async (input: CreateProjectRequest) => createProject(input),
    onSuccess: (res) => {
      setSelected(res.project_id);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      // Also invalidate the chain ribbon so the project-created event
      // appears immediately in the ambient strip.
      void queryClient.invalidateQueries({ queryKey: ['chain-ribbon'] });
      setSubmitted(true);
      // Auto-close shortly after success so the user can see the
      // confirmation but lands on the project list quickly.
      window.setTimeout(() => onCreated(), 1200);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      lifecycle_position: lifecycle,
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create project"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
        <header className="flex items-start justify-between border-b border-neutral-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">New project</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              Project creation lands as a signed event on your chain.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200"
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        <form onSubmit={onSubmit} className="space-y-3 px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-neutral-300">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              placeholder="Pretraining run alpha"
              autoFocus
              required
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-neutral-300">
              Description <span className="text-neutral-600">(optional)</span>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2048}
              rows={2}
              placeholder="Decoder-only LM with GQA and SwiGLU"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none"
            />
          </label>

          <div>
            <span className="mb-1 block text-[11px] font-medium text-neutral-300">
              Lifecycle position
            </span>
            <div className="flex flex-wrap gap-1">
              {LIFECYCLE_OPTIONS.map((opt) => {
                const active = opt === lifecycle;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setLifecycle(opt)}
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
            <p className="mt-1 text-[10px] leading-snug text-neutral-600">
              Where are you in the workflow? You can move this marker as your work progresses.
            </p>
          </div>

          {mutation.error && (
            <div className="rounded border border-red-900/60 bg-red-950/30 px-2 py-1.5 text-[11px] text-red-300">
              {(mutation.error as unknown as ApiError).message ?? 'project creation failed'}
            </div>
          )}

          {submitted && (
            <div className="flex items-center gap-1.5 rounded border border-emerald-700/60 bg-emerald-950/30 px-2 py-1.5 text-[11px] text-emerald-200">
              <CheckCircle size={13} weight="duotone" />
              Project created and signed on chain.
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-neutral-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !name.trim() || submitted}
              className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation.isPending ? (
                <>
                  <CircleNotch size={12} weight="bold" className="animate-spin" />
                  Creating…
                </>
              ) : (
                <>Begin project</>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
