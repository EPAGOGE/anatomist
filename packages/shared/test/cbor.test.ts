import { describe, it, expect } from 'vitest';
import { encodeCanonicalCbor, decodeCbor } from '../src/codec/cbor.js';
import { AttestedEventSchema, type AttestedEvent } from '../src/events/attested-event.js';

describe('CBOR canonical encoding', () => {
  it('round-trips primitive values', () => {
    expect(decodeCbor(encodeCanonicalCbor(42))).toBe(42);
    expect(decodeCbor(encodeCanonicalCbor('hello'))).toBe('hello');
    expect(decodeCbor(encodeCanonicalCbor(true))).toBe(true);
    expect(decodeCbor(encodeCanonicalCbor(null))).toBe(null);
  });

  it('round-trips bigint: cborg returns number for safe-integer-range values, bigint above', () => {
    // cborg encodes any bigint as a CBOR positive/negative integer (major
    // type 0/1). On decode, cborg returns a JS number when the value fits
    // in Number.MAX_SAFE_INTEGER, and bigint otherwise. The Zod schemas
    // for bigint-bearing fields use z.coerce.bigint() to normalize back
    // to bigint after wire decode.
    expect(Number(decodeCbor(encodeCanonicalCbor(0n)))).toBe(0);
    expect(Number(decodeCbor(encodeCanonicalCbor(42n)))).toBe(42);
    expect(decodeCbor(encodeCanonicalCbor(0xffffffffffffffffn))).toBe(0xffffffffffffffffn);
  });

  it('round-trips Uint8Array as CBOR byte string', () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
    const decoded = decodeCbor<Uint8Array>(encodeCanonicalCbor(bytes));
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded)).toEqual([0x01, 0x02, 0x03, 0xff]);
  });

  it('round-trips arrays', () => {
    const arr = [1, 'two', true, null];
    expect(decodeCbor(encodeCanonicalCbor(arr))).toEqual(arr);
  });

  it('round-trips nested objects', () => {
    const obj = { a: 1, b: { c: 'two', d: [3, 4] } };
    expect(decodeCbor(encodeCanonicalCbor(obj))).toEqual(obj);
  });

  it('is deterministic: same input -> same bytes', () => {
    const obj = { z: 1, a: 2, m: 3 };
    const a = encodeCanonicalCbor(obj);
    const b = encodeCanonicalCbor(obj);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('canonical: key order independent of insertion', () => {
    const a = encodeCanonicalCbor({ z: 1, a: 2, m: 3 });
    const b = encodeCanonicalCbor({ a: 2, m: 3, z: 1 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('encodes a full AttestedEvent round-trip', () => {
    const event: AttestedEvent = {
      version: 1,
      chain_id: 'user-primary',
      event_type: 'user-generated',
      source_id: 'src-1',
      causal_predecessors: ['a'.repeat(64)],
      absence_set_delta: [
        {
          expected_hash: 'b'.repeat(64),
          window_start: 10n,
          window_end: 20n,
        },
      ],
      source_reliability: 32768,
      causal_sequence_marker: 42n,
      ground_truth_calibration_indicator: undefined,
      attestation_signature: {
        pq: new Uint8Array([0xaa, 0xbb]),
        classical: new Uint8Array([0xcc, 0xdd]),
      },
      payload_integrity: 'c'.repeat(64),
    };

    const encoded = encodeCanonicalCbor(event);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeCbor<AttestedEvent>(encoded);

    // Re-parse through Zod to confirm structural fidelity.
    const reparsed = AttestedEventSchema.parse(decoded);
    expect(reparsed.version).toBe(1);
    expect(reparsed.source_id).toBe('src-1');
    expect(reparsed.causal_predecessors).toEqual(['a'.repeat(64)]);
    expect(reparsed.causal_sequence_marker).toBe(42n);
    expect(reparsed.source_reliability).toBe(32768);
    expect(reparsed.absence_set_delta[0]?.window_start).toBe(10n);
    expect(reparsed.absence_set_delta[0]?.window_end).toBe(20n);
    expect(Array.from(reparsed.attestation_signature.pq)).toEqual([0xaa, 0xbb]);
    expect(Array.from(reparsed.attestation_signature.classical)).toEqual([0xcc, 0xdd]);
    expect(reparsed.payload_integrity).toBe('c'.repeat(64));
  });
});
