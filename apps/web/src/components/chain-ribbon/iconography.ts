// Phosphor iconography mapping for the chain ribbon — Phase 0 sub-phase E, E4.
//
// The mapping is shared across visualizers so the visual vocabulary
// stays consistent. Per ADR-0031: visualizers MAY override iconography,
// but the default mapping here serves the majority case and gives any
// new visualizer a sensible starting point.
//
// Phosphor is already a dependency (@phosphor-icons/react). We use the
// duotone weight by default — technical-but-warm aesthetic that suits
// EPAGOGE's positioning.

import {
  Graph,
  ChatsCircle,
  Lightbulb,
  Pulse,
  Key,
  User,
  Fingerprint,
  type Icon,
} from '@phosphor-icons/react';
import type { RibbonChainCategory, RibbonEventMeta } from './types.js';

/**
 * Icon for a given chain category. The chain decides the visual
 * neighborhood — events from the canvas chain look "canvas-like"
 * regardless of their event_type discriminator.
 */
export function iconForChain(category: RibbonChainCategory): Icon {
  switch (category) {
    case 'canvas':
      return Graph;
    case 'reasoning':
      return Lightbulb;
    case 'ai':
      return ChatsCircle;
    case 'system':
      return Pulse;
    case 'auth':
      return Key;
    case 'user-primary':
      return User;
    case 'other':
    default:
      return Fingerprint;
  }
}

/**
 * Color hint for a chain category. Tailwind class fragments — the
 * visualizer composes them into its specific styling.
 *
 * Colors picked for legibility on the dark dev-tool background AND
 * for visual separation between categories. Not aiming at a domain
 * convention — these are platform conventions that future visualizers
 * may override.
 */
export interface CategoryColors {
  /** Border / outline color */
  readonly border: string;
  /** Background tint */
  readonly background: string;
  /** Icon + accent foreground */
  readonly foreground: string;
}

export function colorsForChain(category: RibbonChainCategory): CategoryColors {
  switch (category) {
    case 'canvas':
      return {
        border: 'border-emerald-700/40',
        background: 'bg-emerald-950/30',
        foreground: 'text-emerald-300',
      };
    case 'reasoning':
      return {
        border: 'border-amber-700/40',
        background: 'bg-amber-950/30',
        foreground: 'text-amber-300',
      };
    case 'ai':
      return {
        border: 'border-violet-700/40',
        background: 'bg-violet-950/30',
        foreground: 'text-violet-300',
      };
    case 'system':
      return {
        border: 'border-sky-700/40',
        background: 'bg-sky-950/30',
        foreground: 'text-sky-300',
      };
    case 'auth':
      return {
        border: 'border-rose-700/40',
        background: 'bg-rose-950/30',
        foreground: 'text-rose-300',
      };
    case 'user-primary':
      return {
        border: 'border-neutral-700/40',
        background: 'bg-neutral-900/30',
        foreground: 'text-neutral-200',
      };
    case 'other':
    default:
      return {
        border: 'border-neutral-700/40',
        background: 'bg-neutral-900/30',
        foreground: 'text-neutral-400',
      };
  }
}

/**
 * Normalize a raw chain_id into the display category + label.
 * The chain_id schema is documented in packages/shared/src/events/chain-id.ts.
 */
export function categorizeChain(chainId: string): {
  category: RibbonChainCategory;
  label: string;
} {
  if (chainId.startsWith('architecture-composition:'))
    return { category: 'canvas', label: 'canvas' };
  if (chainId.startsWith('user-primary:')) return { category: 'user-primary', label: 'user' };
  if (chainId === 'reasoning-capture') return { category: 'reasoning', label: 'reasoning' };
  if (chainId === 'ai-interaction') return { category: 'ai', label: 'ai' };
  if (chainId === 'system-operational') return { category: 'system', label: 'system' };
  if (chainId === 'auth-events') return { category: 'auth', label: 'auth' };
  return { category: 'other', label: chainId };
}

/** Compose a hover summary string for an event chip. */
export function eventTooltip(event: RibbonEventMeta): string {
  const verif = event.verification === 'verified' ? '✓ verified' : event.verification;
  return [
    `${event.chainLabel} · ${event.eventType}`,
    `#${event.marker}`,
    event.eventHash.slice(0, 16) + '…',
    verif,
  ].join('\n');
}
