import { describe, it, expect } from 'vitest';
import {
  makeReliability,
  clampToUnit,
  toWireU16,
  fromWireU16,
  ZERO,
  ONE,
  RELIABILITY_WIRE_MAX,
} from '../src/reliability/reliability.js';

describe('Reliability — construction and validation', () => {
  it('accepts values in [0, 1]', () => {
    expect(makeReliability(0)).toBe(0);
    expect(makeReliability(0.5)).toBe(0.5);
    expect(makeReliability(1)).toBe(1);
  });

  it('rejects non-finite', () => {
    expect(() => makeReliability(NaN)).toThrow(RangeError);
    expect(() => makeReliability(Infinity)).toThrow(RangeError);
    expect(() => makeReliability(-Infinity)).toThrow(RangeError);
  });

  it('rejects out-of-range', () => {
    expect(() => makeReliability(-0.0001)).toThrow(RangeError);
    expect(() => makeReliability(1.0001)).toThrow(RangeError);
    expect(() => makeReliability(2)).toThrow(RangeError);
    expect(() => makeReliability(-1)).toThrow(RangeError);
  });

  it('constants', () => {
    expect(ZERO).toBe(0);
    expect(ONE).toBe(1);
  });
});

describe('Reliability — clampToUnit', () => {
  it('passes through values in [0, 1]', () => {
    expect(clampToUnit(0.3)).toBe(0.3);
    expect(clampToUnit(0.7)).toBe(0.7);
  });

  it('clamps above 1', () => {
    expect(clampToUnit(1.5)).toBe(1);
    expect(clampToUnit(100)).toBe(1);
  });

  it('clamps below 0', () => {
    expect(clampToUnit(-0.5)).toBe(0);
    expect(clampToUnit(-100)).toBe(0);
  });

  it('handles boundary values exactly', () => {
    expect(clampToUnit(0)).toBe(0);
    expect(clampToUnit(1)).toBe(1);
  });

  it('rejects non-finite', () => {
    expect(() => clampToUnit(NaN)).toThrow(RangeError);
    expect(() => clampToUnit(Infinity)).toThrow(RangeError);
    expect(() => clampToUnit(-Infinity)).toThrow(RangeError);
  });
});

describe('Reliability — wire encoding (16-bit fixed-point)', () => {
  it('toWireU16: endpoints', () => {
    expect(toWireU16(ZERO)).toBe(0);
    expect(toWireU16(ONE)).toBe(0xffff);
  });

  it('toWireU16: midpoint', () => {
    const half = makeReliability(0.5);
    const wire = toWireU16(half);
    expect(wire).toBeGreaterThanOrEqual(32767);
    expect(wire).toBeLessThanOrEqual(32768);
  });

  it('fromWireU16: endpoints', () => {
    expect(fromWireU16(0)).toBe(0);
    expect(fromWireU16(0xffff)).toBe(1);
  });

  it('fromWireU16: rejects out-of-range', () => {
    expect(() => fromWireU16(-1)).toThrow(RangeError);
    expect(() => fromWireU16(0x10000)).toThrow(RangeError);
    expect(() => fromWireU16(0.5)).toThrow(RangeError);
  });

  it('round-trip within wire granularity', () => {
    const cases = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
    for (const v of cases) {
      const r = makeReliability(v);
      const wire = toWireU16(r);
      const back = fromWireU16(wire);
      // Granularity is 1/65535 ≈ 1.526e-5; allow that as tolerance.
      expect(Math.abs((back as number) - v)).toBeLessThanOrEqual(1 / 65535);
    }
  });

  it('exports the wire max constant', () => {
    expect(RELIABILITY_WIRE_MAX).toBe(0xffff);
  });
});
