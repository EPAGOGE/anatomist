import {
  encodeCanonicalCbor,
  decodeCbor,
  makeReliability,
  toWireU16,
  fromWireU16,
  RELIABILITY_WIRE_MAX,
  AttestedEventSchema,
} from '@epagoge/shared';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

export const cborRoundtripCheck: Check = makeCheck('cbor-roundtrip', async () => {
  const sample = {
    z_key: 'three',
    a_key: 1,
    m_key: [1, 2, 3],
    bytes: new Uint8Array([0xaa, 0xbb]),
    big: 0xffffffffffffffffn,
  };
  const encoded = encodeCanonicalCbor(sample);
  const decoded = decodeCbor<typeof sample>(encoded);
  if (Number(decoded.a_key) !== 1) throw new Error('a_key did not round-trip');
  if (decoded.z_key !== 'three') throw new Error('z_key did not round-trip');
  if (!(decoded.bytes instanceof Uint8Array)) throw new Error('Uint8Array decoded to wrong type');
  if (decoded.big !== 0xffffffffffffffffn) throw new Error('large bigint did not round-trip');
  // Determinism: two encodings of the same input must match byte-for-byte.
  const second = encodeCanonicalCbor(sample);
  if (encoded.length !== second.length) throw new Error('encoding length not deterministic');
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== second[i]) throw new Error(`byte ${i} differs between encodings`);
  }
  return `${encoded.length} bytes, deterministic`;
});

export const reliabilityCheck: Check = makeCheck('reliability-wire-roundtrip', async () => {
  // Boundary values round-trip exactly.
  for (const v of [0, 1]) {
    const r = makeReliability(v);
    const wire = toWireU16(r);
    if (wire < 0 || wire > RELIABILITY_WIRE_MAX) {
      throw new Error(`wire out of range for ${v}: ${wire}`);
    }
    const back = fromWireU16(wire);
    if ((back as number) !== v) {
      throw new Error(`endpoint ${v} did not round-trip: got ${back}`);
    }
  }
  // Middle values within one wire tick.
  const granularity = 1 / RELIABILITY_WIRE_MAX;
  for (const v of [0.25, 0.5, 0.75]) {
    const r = makeReliability(v);
    const wire = toWireU16(r);
    const back = fromWireU16(wire);
    if (Math.abs((back as number) - v) > granularity) {
      throw new Error(`${v} did not round-trip within granularity: got ${back}`);
    }
  }
  return 'endpoints exact, mid-values within 1 tick';
});

export const schemaValidationCheck: Check = makeCheck('zod-schema-load', async () => {
  // Validates the package's AttestedEvent schema parses a representative event.
  const sample = {
    version: 1 as const,
    chain_id: 'system-operational',
    event_type: 'system-operational' as const,
    source_id: 'doctor',
    causal_predecessors: [],
    absence_set_delta: [],
    source_reliability: 65535,
    causal_sequence_marker: 1n,
    ground_truth_calibration_indicator: undefined,
    attestation_signature: {
      pq: new Uint8Array([0x00]),
      classical: new Uint8Array([0x00]),
    },
    payload_integrity: 'a'.repeat(64),
  };
  AttestedEventSchema.parse(sample);
  return 'AttestedEvent schema OK';
});
