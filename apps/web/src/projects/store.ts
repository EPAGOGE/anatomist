// Selected-project state — F-0 Criterion 1.
//
// The current project scopes the canvas, chat, and chain views. We
// persist the selection in localStorage so a refresh doesn't drop
// the user back to "no project," but the persisted value is
// validated on next page load against the server's list (a project
// may have been deleted; in F-0 this isn't possible yet, but the
// validation is cheap and future-proofs).
//
// Per ADR-0036: project membership is per-user today; Phase 2 will
// extend to multi-member with team-level scoping. The store here
// only tracks the active selection; the projects list itself comes
// from the API via TanStack Query.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ProjectState {
  /** Currently selected project id, or null when none chosen. */
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      setSelectedProjectId: (id) => set({ selectedProjectId: id }),
    }),
    {
      name: 'epagoge.project',
      partialize: (state) => ({ selectedProjectId: state.selectedProjectId }),
    },
  ),
);
