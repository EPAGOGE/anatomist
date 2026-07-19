import { Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getMe } from '../api/endpoints.js';
import { useAuthStore } from '../auth/store.js';
import { LeftRail } from './LeftRail.js';
import { RibbonContainer } from './chain-ribbon/index.js';

/**
 * Authenticated shell.
 *
 * Layout: 64px left rail (icon nav, Claude-style) + main content area +
 * chain ribbon at the bottom. The legacy horizontal top nav was replaced
 * on 2026-06-21 per user feedback ("simplify the top and icons. I really
 * like the modern AI or claude style menus that are clean but work and
 * connect to relevant placing"). Workbench is the second nav entry after
 * Home — it's the MI primary surface post-pivot.
 *
 * Aesthetic: Obsidian + Iridescent (see docs/MI_Workbench.md design
 * carryover). Dark cool-obsidian background; active nav uses bg-accent/15
 * with a thin fuchsia bar on the left edge; the iridescent gradient stays
 * reserved for chain-signing moments only.
 */
export function Layout() {
  const location = useLocation();

  // Hydrate the local identity from the API once per app load. The store
  // ships a placeholder; /me returns the real provisioned owner (its uuid
  // scopes the per-user chains the ribbon subscribes to).
  const setUser = useAuthStore((s) => s.setUser);
  useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { user } = await getMe();
      setUser(user);
      return user;
    },
    staleTime: Infinity,
    retry: 1,
  });

  // Canvas is the art. On /canvas, the main area runs full-bleed — no
  // max-width cap, no horizontal padding — so the graph fills the
  // viewport. Other pages stay centered with the editorial max-w-7xl.
  const isCanvas = location.pathname === '/canvas';

  return (
    <div className="bg-obsidian text-text flex min-h-screen">
      <LeftRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <main
          className={
            isCanvas ? 'flex-1 overflow-hidden' : 'mx-auto w-full max-w-7xl flex-1 px-6 py-6'
          }
        >
          <Outlet />
        </main>
        <RibbonContainer />
      </div>
    </div>
  );
}
