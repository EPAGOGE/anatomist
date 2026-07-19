// Local identity. The app is local-first and single-user — there is no
// login. Consumers that used to read the authenticated profile (welcome
// greeting, chain ribbon) get a stable local identity instead. Kept as a
// zustand store so a hosted multi-user variant can swap real auth back in
// behind the same interface.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CurrentUser {
  id: string;
  source_id: string;
  email: string | null;
  display_name: string;
  chain_id: string;
}

export const LOCAL_USER: CurrentUser = {
  id: 'local',
  source_id: 'local',
  email: null,
  display_name: 'Local',
  chain_id: 'user-primary:local',
};

interface AuthState {
  user: CurrentUser;
  setUser: (user: CurrentUser) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: LOCAL_USER,
      setUser: (user) => set({ user }),
    }),
    {
      name: 'epagoge.auth',
      partialize: (state) => ({ user: state.user }),
      // v2: tokens removed with the login. Drop any persisted pre-v2 state
      // (stale tokens / null user) rather than merging it in.
      version: 2,
      migrate: () => ({ user: LOCAL_USER }),
    },
  ),
);
