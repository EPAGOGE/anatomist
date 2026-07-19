import { describe, it, expect } from 'vitest';
import {
  withinReliabilityScope,
  assertNotInReliabilityScope,
  ReliabilityPathViolation,
  currentReliabilityFrame,
} from '../src/index.js';

describe('runtime-guard', () => {
  it('assertNotInReliabilityScope passes outside a scope', () => {
    expect(() => assertNotInReliabilityScope('ai-call')).not.toThrow();
  });

  it('assertNotInReliabilityScope throws inside a scope', async () => {
    await withinReliabilityScope('verify-chain', async () => {
      expect(() => assertNotInReliabilityScope('ai-call')).toThrow(ReliabilityPathViolation);
    });
  });

  it('scope frame is observable from inside', async () => {
    await withinReliabilityScope('test-frame', async () => {
      const frame = currentReliabilityFrame();
      expect(frame?.label).toBe('test-frame');
    });
  });

  it('scope unwinds after the function returns', async () => {
    await withinReliabilityScope('inner', async () => undefined);
    expect(currentReliabilityFrame()).toBeUndefined();
    expect(() => assertNotInReliabilityScope('ai-call')).not.toThrow();
  });

  it('thrown error carries frame + caller labels', async () => {
    try {
      await withinReliabilityScope('rs-foo', async () => {
        assertNotInReliabilityScope('caller-bar');
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReliabilityPathViolation);
      const e = err as ReliabilityPathViolation;
      expect(e.aiCallerLabel).toBe('caller-bar');
      expect(e.reliabilityFrameLabel).toBe('rs-foo');
    }
  });
});
