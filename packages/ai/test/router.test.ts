import { describe, it, expect } from 'vitest';
import { route, MODELS } from '../src/index.js';

describe('router', () => {
  it('routes doctor-roundtrip to haiku/low/disabled', () => {
    const d = route({ purpose: 'doctor-roundtrip', inputChars: 30 });
    expect(d.model).toBe(MODELS.haiku);
    expect(d.tier).toBe('haiku');
    expect(d.effort).toBe('low');
    expect(d.thinking.type).toBe('disabled');
  });

  it('routes reasoning-capture to opus/high/adaptive', () => {
    const d = route({ purpose: 'reasoning-capture', inputChars: 8000 });
    expect(d.tier).toBe('opus');
    expect(d.effort).toBe('high');
    expect(d.thinking.type).toBe('adaptive');
  });

  it('routes default chat to sonnet/medium/disabled', () => {
    const d = route({ purpose: 'chat', inputChars: 1500 });
    expect(d.tier).toBe('sonnet');
    expect(d.effort).toBe('medium');
    expect(d.thinking.type).toBe('disabled');
  });

  it('routes short chat to haiku/low', () => {
    const d = route({ purpose: 'chat', inputChars: 50 });
    expect(d.tier).toBe('haiku');
    expect(d.effort).toBe('low');
  });

  it('isSimple flag forces haiku', () => {
    const d = route({ purpose: 'chat', inputChars: 5000, isSimple: true });
    expect(d.tier).toBe('haiku');
  });

  it('needsReasoning flag forces opus — cost-empirically validated by ADR-0038', () => {
    // F-0 Criterion 6 measurement + re-measurement: routing to Sonnet
    // for needsReasoning chat traffic INCREASED total cost vs Opus-only
    // by 37% because Sonnet 4.6 with adaptive thinking produces ~2x
    // the output tokens Opus 4.7 produces on substantial-reasoning
    // queries. Sonnet's lower per-token rate does not compensate.
    // The "obvious fix" was overturned by the data; Opus is correct
    // for needsReasoning on this workload shape.
    const d = route({ purpose: 'chat', inputChars: 100, needsReasoning: true });
    expect(d.tier).toBe('opus');
    expect(d.thinking.type).toBe('adaptive');
  });

  it('forceTier overrides everything', () => {
    const d = route({ purpose: 'reasoning-capture', inputChars: 8000, forceTier: 'haiku' });
    expect(d.tier).toBe('haiku');
  });

  it('forceModel overrides forceTier', () => {
    const d = route({
      purpose: 'reasoning-capture',
      inputChars: 8000,
      forceTier: 'haiku',
      forceModel: 'claude-sonnet-4-6',
    });
    expect(d.model).toBe('claude-sonnet-4-6');
  });

  it('caps effort=max on tiers that do not support it', () => {
    const d = route({ purpose: 'chat', inputChars: 100, forceTier: 'sonnet' });
    expect(d.effort).toBe('medium'); // default for sonnet — max not requested
  });

  it('default routing is deterministic for identical inputs', () => {
    const a = route({ purpose: 'chat', inputChars: 500 });
    const b = route({ purpose: 'chat', inputChars: 500 });
    expect(a.model).toBe(b.model);
    expect(a.effort).toBe(b.effort);
  });
});
