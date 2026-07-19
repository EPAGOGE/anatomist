// Left-rail nav — Claude-style icon sidebar.
//
// Replaces the legacy horizontal top nav on 2026-06-21 per user feedback:
// "simplify the top and icons. I really like the modern AI or claude style
// menus that are clean but work and connect to relevant placing." This 64px
// vertical rail puts every section one click away with a tooltip on hover,
// and frees the top of the page for content rather than chrome.
//
// Workbench is the second entry (after Home) — it's the MI primary surface
// post-pivot. Legacy pages (Canvas, Projects, Chains, Chat, Cost) follow.

import type { Icon } from '@phosphor-icons/react';
import {
  ChatCircle,
  Cube,
  FolderOpen,
  House,
  ProjectorScreenChart,
  Sparkle,
} from '@phosphor-icons/react';
import { Link, NavLink } from 'react-router-dom';

type NavEntry = {
  to: string;
  label: string;
  Icon: Icon;
  end?: boolean;
};

const PRIMARY: NavEntry[] = [
  { to: '/', label: 'Home', Icon: House, end: true },
  { to: '/workbench', label: 'Anatomist', Icon: Sparkle },
  { to: '/canvas', label: 'Canvas', Icon: ProjectorScreenChart },
  { to: '/projects', label: 'Projects', Icon: FolderOpen },
  { to: '/chains-list', label: 'Chains', Icon: Cube },
  { to: '/chat', label: 'Chat', Icon: ChatCircle },
];

export function LeftRail() {
  return (
    <aside className="bg-panel/40 border-line sticky top-0 flex h-screen w-16 shrink-0 flex-col items-center gap-1 border-r py-3 backdrop-blur">
      {/* Brand mark — clicking goes Home. Subtle fuchsia, the same "//"
          punctuation the wordmark used before. */}
      <Link
        to="/"
        title="Anatomist"
        aria-label="Anatomist home"
        className="text-accent/70 hover:text-accent mb-2 text-lg font-bold transition"
      >
        //
      </Link>

      {/* Primary nav — icons with hover tooltips (native title attribute,
          no popover library needed for V1). */}
      <nav className="flex flex-1 flex-col items-center gap-1" aria-label="Primary">
        {PRIMARY.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            title={label}
            aria-label={label}
            className={({ isActive }) =>
              [
                'group relative flex h-10 w-10 items-center justify-center rounded-lg transition',
                isActive
                  ? 'bg-accent/15 text-accent before:bg-accent before:absolute before:left-0 before:top-1/2 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-r'
                  : 'text-dim hover:bg-panel-2 hover:text-text',
              ].join(' ')
            }
          >
            <Icon size={18} weight="duotone" />
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
