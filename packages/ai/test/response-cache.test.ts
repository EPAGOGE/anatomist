import { describe, it, expect } from 'vitest';
import { computeCacheKey, isCacheable, MODELS } from '../src/index.js';

describe('response-cache', () => {
  it('isCacheable rejects adaptive thinking', () => {
    expect(isCacheable({ effort: 'low', thinking: { type: 'adaptive' } })).toBe(false);
  });

  it('isCacheable rejects high+ effort', () => {
    expect(isCacheable({ effort: 'high', thinking: { type: 'disabled' } })).toBe(false);
    expect(isCacheable({ effort: 'xhigh', thinking: { type: 'disabled' } })).toBe(false);
    expect(isCacheable({ effort: 'max', thinking: { type: 'disabled' } })).toBe(false);
  });

  it('isCacheable accepts low/medium + disabled thinking', () => {
    expect(isCacheable({ effort: 'low', thinking: { type: 'disabled' } })).toBe(true);
    expect(isCacheable({ effort: 'medium', thinking: { type: 'disabled' } })).toBe(true);
  });

  it('isCacheable accepts missing effort (defaults to low)', () => {
    expect(isCacheable({ thinking: { type: 'disabled' } })).toBe(true);
  });

  it('computeCacheKey is deterministic', () => {
    const a = computeCacheKey({
      model: MODELS.haiku,
      system: 'Always reply with one word.',
      messages: [{ role: 'user', content: 'classify: hello world' }],
      effort: 'low',
      thinking: { type: 'disabled' },
    });
    const b = computeCacheKey({
      model: MODELS.haiku,
      system: 'Always reply with one word.',
      messages: [{ role: 'user', content: 'classify: hello world' }],
      effort: 'low',
      thinking: { type: 'disabled' },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computeCacheKey changes when inputs change', () => {
    const a = computeCacheKey({
      model: MODELS.haiku,
      messages: [{ role: 'user', content: 'hello' }],
      effort: 'low',
      thinking: { type: 'disabled' },
    });
    const differentMessage = computeCacheKey({
      model: MODELS.haiku,
      messages: [{ role: 'user', content: 'world' }],
      effort: 'low',
      thinking: { type: 'disabled' },
    });
    const differentModel = computeCacheKey({
      model: MODELS.sonnet,
      messages: [{ role: 'user', content: 'hello' }],
      effort: 'low',
      thinking: { type: 'disabled' },
    });
    expect(a).not.toBe(differentMessage);
    expect(a).not.toBe(differentModel);
  });

  it('computeCacheKey is invariant to system-segment cache_control hints', () => {
    const stringSys = computeCacheKey({
      model: MODELS.haiku,
      system: 'rule',
      messages: [{ role: 'user', content: 'q' }],
      effort: 'low',
      thinking: { type: 'disabled' },
    });
    const segmentSys = computeCacheKey({
      model: MODELS.haiku,
      system: [{ text: 'rule', cacheBreakpoint: true }],
      messages: [{ role: 'user', content: 'q' }],
      effort: 'low',
      thinking: { type: 'disabled' },
    });
    expect(stringSys).toBe(segmentSys);
  });
});
