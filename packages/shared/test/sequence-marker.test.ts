import { describe, it, expect } from 'vitest';
import {
  makeSequenceMarker,
  compareSequenceMarkers,
  nextSequenceMarker,
  maxSequenceMarker,
} from '../src/events/sequence-marker.js';

describe('SequenceMarker', () => {
  it('makeSequenceMarker accepts number and bigint', () => {
    expect(makeSequenceMarker(0)).toBe(0n);
    expect(makeSequenceMarker(42)).toBe(42n);
    expect(makeSequenceMarker(42n)).toBe(42n);
    expect(makeSequenceMarker(0xffffffffffffffffn)).toBe(0xffffffffffffffffn);
  });

  it('makeSequenceMarker rejects negative', () => {
    expect(() => makeSequenceMarker(-1)).toThrow(RangeError);
    expect(() => makeSequenceMarker(-1n)).toThrow(RangeError);
  });

  it('makeSequenceMarker rejects above 64-bit unsigned', () => {
    expect(() => makeSequenceMarker(0xffffffffffffffffn + 1n)).toThrow(RangeError);
  });

  it('compareSequenceMarkers', () => {
    const a = makeSequenceMarker(10);
    const b = makeSequenceMarker(20);
    const c = makeSequenceMarker(10);
    expect(compareSequenceMarkers(a, b)).toBe(-1);
    expect(compareSequenceMarkers(b, a)).toBe(1);
    expect(compareSequenceMarkers(a, c)).toBe(0);
  });

  it('nextSequenceMarker increments by one', () => {
    expect(nextSequenceMarker(makeSequenceMarker(5))).toBe(6n);
    expect(nextSequenceMarker(makeSequenceMarker(0))).toBe(1n);
  });

  it('maxSequenceMarker finds the largest', () => {
    const markers = [3, 1, 7, 2, 5].map(makeSequenceMarker);
    expect(maxSequenceMarker(markers)).toBe(7n);
  });

  it('maxSequenceMarker handles single element', () => {
    expect(maxSequenceMarker([makeSequenceMarker(42)])).toBe(42n);
  });

  it('maxSequenceMarker throws on empty', () => {
    expect(() => maxSequenceMarker([])).toThrow(RangeError);
  });
});
