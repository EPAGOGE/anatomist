// Chain-ribbon pure-logic tests — Phase 0 sub-phase E, E4.
//
// Tests cover the chain categorization, tooltip composition, and the
// visualizer registry composition. React component rendering is
// out of scope for these tests (apps/web has no jsdom test harness
// yet — that lands with a future test-infrastructure tranche); the
// rendering is verified by typecheck + visual inspection in the live
// app.

import { describe, it, expect } from 'vitest';
import { categorizeChain, eventTooltip, iconForChain, colorsForChain } from './iconography.js';
import { listRibbonVisualizers } from './RibbonContainer.js';
import { DefaultRibbon } from './visualizers/DefaultRibbon.js';
import type { RibbonEventMeta } from './types.js';

describe('categorizeChain', () => {
  it('maps architecture-composition chains to canvas category', () => {
    const { category, label } = categorizeChain('architecture-composition:user-uuid-here');
    expect(category).toBe('canvas');
    expect(label).toBe('canvas');
  });

  it('maps user-primary chains to user-primary category', () => {
    const { category, label } = categorizeChain('user-primary:user-uuid');
    expect(category).toBe('user-primary');
    expect(label).toBe('user');
  });

  it('maps reasoning-capture exact match', () => {
    expect(categorizeChain('reasoning-capture')).toEqual({
      category: 'reasoning',
      label: 'reasoning',
    });
  });

  it('maps ai-interaction exact match', () => {
    expect(categorizeChain('ai-interaction')).toEqual({ category: 'ai', label: 'ai' });
  });

  it('maps system-operational exact match', () => {
    expect(categorizeChain('system-operational')).toEqual({
      category: 'system',
      label: 'system',
    });
  });

  it('maps auth-events exact match', () => {
    expect(categorizeChain('auth-events')).toEqual({ category: 'auth', label: 'auth' });
  });

  it('falls back to other for unknown chains', () => {
    const { category, label } = categorizeChain('domain-specific-chain');
    expect(category).toBe('other');
    expect(label).toBe('domain-specific-chain');
  });
});

describe('iconography', () => {
  it('returns a non-null icon for every category', () => {
    for (const cat of [
      'canvas',
      'reasoning',
      'ai',
      'system',
      'auth',
      'user-primary',
      'other',
    ] as const) {
      expect(iconForChain(cat)).toBeDefined();
    }
  });

  it('returns colors for every category', () => {
    for (const cat of [
      'canvas',
      'reasoning',
      'ai',
      'system',
      'auth',
      'user-primary',
      'other',
    ] as const) {
      const c = colorsForChain(cat);
      expect(c.border).toMatch(/^border-/);
      expect(c.background).toMatch(/^bg-/);
      expect(c.foreground).toMatch(/^text-/);
    }
  });

  it('canvas and reasoning have distinct color palettes (visual separation)', () => {
    expect(colorsForChain('canvas').foreground).not.toBe(colorsForChain('reasoning').foreground);
  });
});

describe('eventTooltip', () => {
  it('composes a multi-line tooltip with key details', () => {
    const ev: RibbonEventMeta = {
      eventHash: 'a'.repeat(64),
      chainId: 'reasoning-capture',
      eventType: 'system-operational',
      marker: '42',
      causalPredecessors: ['b'.repeat(64)],
      sourceReliability: 65536,
      payloadIntegrity: 'c'.repeat(64),
      orderKey: '42',
      category: 'reasoning',
      chainLabel: 'reasoning',
      verification: 'verified',
    };
    const tt = eventTooltip(ev);
    expect(tt).toContain('reasoning');
    expect(tt).toContain('system-operational');
    expect(tt).toContain('#42');
    expect(tt).toContain('aaaaaaaaaaaaaaaa'); // truncated hash
    expect(tt).toContain('✓ verified');
  });

  it('surfaces unverified state when present', () => {
    const ev: RibbonEventMeta = {
      eventHash: '1'.repeat(64),
      chainId: 'ai-interaction',
      eventType: 'synthetic-derived',
      marker: '7',
      causalPredecessors: [],
      sourceReliability: 0,
      payloadIntegrity: '2'.repeat(64),
      orderKey: '7',
      category: 'ai',
      chainLabel: 'ai',
      verification: 'unverified',
    };
    expect(eventTooltip(ev)).toContain('unverified');
  });
});

describe('visualizer registry', () => {
  it('exposes at least the default visualizer', () => {
    const list = listRibbonVisualizers();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const ids = list.map((v) => v.id);
    expect(ids).toContain(DefaultRibbon.id);
  });

  it('every registered visualizer satisfies the plugin contract', () => {
    for (const v of listRibbonVisualizers()) {
      expect(v.id).toMatch(/^[a-z][a-z0-9-]*$/); // url-safe slug
      expect(v.displayName.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
      expect(v.Component).toBeDefined();
    }
  });

  it('default visualizer id is stable (used by user preference setting)', () => {
    expect(DefaultRibbon.id).toBe('default-chip-and-connection');
  });
});
