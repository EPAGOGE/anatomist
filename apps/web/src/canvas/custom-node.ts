// RETE_BRIDGE: typed dispatcher for ReactPresets.classic.setup({ customize: { node } })
// Bug that established it: Day 11 propVersion + key-remount fix (3d5b768) surfaced the
//   cast-lies recurrence shape — predicted at editor.ts:112 (`return AttentionNode as any`)
//   to fire on the next custom node type addition. Without this helper, each new custom
//   node type would inline its own regex + `as any` return, creating one cast-lies surface
//   per node type and one place where the matchers can drift out of sync with the
//   `hasVisualization` heuristic in CanvasPage.tsx.
// DO NOT simplify: keep all variance casts inside this file. Caller sites pass plain
//   typed tuples; the runtime `instanceof ArchitectureNode` check below replaces the
//   `as ArchitectureNode` social-contract cast with an actual prototype verification
//   (the matcher list is the canvas's source of truth for which component ids have a
//   3D body — CanvasPage.tsx consumes the same list via `nodeHasCustomRenderer`).
//
// RETE_INVARIANT_001 holds: the matcher receives the live ArchitectureNode instance
// from Rete; it is never spread, copied, or serialized through this surface.

import type { ComponentType } from 'react';
import type { ReactArea2D } from 'rete-react-plugin';
import { ArchitectureNode, type SchemeNode, type SchemeConn } from './nodes.js';
import { AttentionNode } from './AttentionNode.js';
import { FeedForwardNode } from './FeedForwardNode.js';

type Scheme = { Node: SchemeNode; Connection: SchemeConn };

/**
 * Props every custom Rete node component receives from the React preset.
 * Mirrors the shape AttentionNode and FeedForwardNode are written against
 * — the `data` payload is the live class instance plus a few UI-state
 * fields the area plugin injects (width, height, selected).
 */
export interface ReteCustomNodeProps {
  data: ArchitectureNode & {
    width?: number;
    height?: number;
    selected?: boolean;
  };
  emit: (props: ReactArea2D<Scheme>) => void;
}

/**
 * Matcher signature for canvas-dispatch rules. The input is intentionally
 * narrow to just `componentId` — canvas dispatch is per-component-type,
 * not per-instance. A matcher needing per-instance discrimination (e.g.
 * "MoE variant vs canonical FFN") belongs inside the renderer component
 * (see FeedForwardNode.tsx's isMoEVariant), not at this dispatcher level.
 *
 * The narrow input also closes a cast-lies surface: the probe path
 * (`componentIdHasCustomRenderer`) used to build a `{ componentId } as
 * ArchitectureNode` stub that worked only because the existing matchers
 * happened to read just `componentId`. Future matchers that read more
 * fields would silently misbehave on the probe path. Typing the input
 * here forces the design decision at compile time — the literal
 * `{ componentId }` now structurally IS the matcher's input type, no
 * cast required, and any matcher trying to read `properties` or `spec`
 * gets a typecheck error pointing at this comment.
 */
export type ReteCustomNodeMatcher = (node: { readonly componentId: string }) => boolean;

/**
 * One rule: a matcher paired with the React component that renders
 * matching nodes. First match wins (in array order).
 */
export type ReteCustomNodeRule = readonly [
  matcher: ReteCustomNodeMatcher,
  Component: ComponentType<ReteCustomNodeProps>,
];

/**
 * Named matcher: any attention-family component (MHA, MQA, GQA, Flash,
 * SlidingWindow, Cross). Used by the canvas dispatcher + by the page's
 * hasVisualization heuristic to keep them in sync.
 */
export const isAttentionLike: ReteCustomNodeMatcher = (node) =>
  /attention/i.test(node.componentId) || /\bmha\b/i.test(node.componentId);

/**
 * Named matcher: any FFN-family component (canonical FeedForward,
 * GatedFFN, MoEFFN). FeedForwardNode internally picks the right viz —
 * tunnel for canonical/gated, branching for MoE.
 */
export const isFFNLike: ReteCustomNodeMatcher = (node) => /ffn|feedforward/i.test(node.componentId);

/**
 * Canvas-wide registry of custom node renderers. Order = match priority
 * (first match wins). Adding a new visual-vocabulary entry is adding a
 * row here. editor.ts builds the resolver from this list; CanvasPage.tsx
 * derives hasVisualization from the same list so the two surfaces cannot
 * drift apart.
 */
export const CUSTOM_NODE_RULES: readonly ReteCustomNodeRule[] = [
  [isAttentionLike, AttentionNode],
  [isFFNLike, FeedForwardNode],
];

/**
 * True if any registered custom renderer would claim this node — i.e.
 * the canvas will draw a 3D body for it. The Modulate sidebar uses this
 * to decide whether to offer a larger view + parameter hints.
 */
export function nodeHasCustomRenderer(node: ArchitectureNode | null): boolean {
  if (!node) return false;
  return CUSTOM_NODE_RULES.some(([matcher]) => matcher(node));
}

/**
 * String-id variant of `nodeHasCustomRenderer` for callers that only have
 * the componentId (not the instance). No cast required — `{ componentId }`
 * structurally satisfies the matcher's input type by construction.
 */
export function componentIdHasCustomRenderer(componentId: string | undefined): boolean {
  if (!componentId) return false;
  return CUSTOM_NODE_RULES.some(([matcher]) => matcher({ componentId }));
}

// The resolver's return type fights Rete's loose ClassicScheme variance;
// we contain that cast inside `createReteCustomNode` rather than at every
// call site. This is the single cast surface — all caller sites stay clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReteNodeResolver = (context: { payload?: unknown }) => ComponentType<any> | null;

/**
 * Build a `customize.node` resolver from a list of rules. The returned
 * function checks the payload is an actual ArchitectureNode instance
 * (`instanceof`, not a structural cast — per IDEA-491, `as` is a social
 * contract; `instanceof` is a runtime check) and dispatches to the first
 * matching component, or returns null to fall through to Rete's default
 * classic renderer.
 */
export function createReteCustomNode(rules: readonly ReteCustomNodeRule[]): ReteNodeResolver {
  return (context) => {
    const payload = context?.payload;
    if (!(payload instanceof ArchitectureNode)) return null;
    for (const [matcher, Component] of rules) {
      if (matcher(payload)) return Component;
    }
    return null;
  };
}
