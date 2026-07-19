import { describe, it, expect } from 'vitest';
import {
  AttestedEventSchema,
  AbsenceEntrySchema,
  HashSchema,
  SourceIdSchema,
  SequenceMarkerSchema,
  ReliabilityWireSchema,
  AttestationSignatureSchema,
  ATTESTED_EVENT_VERSION,
  MAX_PREDECESSOR_COUNT,
  type AttestedEvent,
} from '../src/events/attested-event.js';
import {
  EVENT_TYPES,
  EventTypeSchema,
  ChainIdSchema,
  WELL_KNOWN_CHAINS,
} from '../src/events/chain-id.js';

const validHash = (n: number) => n.toString(16).padStart(64, '0');

const validEvent = (overrides: Partial<AttestedEvent> = {}): AttestedEvent => ({
  version: 1,
  chain_id: 'user-primary',
  event_type: 'user-generated',
  source_id: 'src-1',
  causal_predecessors: [validHash(1)],
  absence_set_delta: [],
  source_reliability: 32768,
  causal_sequence_marker: 5n,
  ground_truth_calibration_indicator: undefined,
  attestation_signature: {
    pq: new Uint8Array([0x01]),
    classical: new Uint8Array([0x02]),
  },
  payload_integrity: validHash(2),
  ...overrides,
});

describe('AttestedEvent — schema validation', () => {
  it('accepts a minimal valid event', () => {
    const e = validEvent();
    expect(() => AttestedEventSchema.parse(e)).not.toThrow();
  });

  it('exports the version and predecessor cardinality constants', () => {
    expect(ATTESTED_EVENT_VERSION).toBe(1);
    expect(MAX_PREDECESSOR_COUNT).toBe(10);
  });

  it('rejects wrong version', () => {
    expect(() => AttestedEventSchema.parse(validEvent({ version: 2 as 1 }))).toThrow();
  });

  it('rejects more than 10 predecessors', () => {
    const predecessors = Array.from({ length: 11 }, (_, i) => validHash(i + 1));
    expect(() =>
      AttestedEventSchema.parse(validEvent({ causal_predecessors: predecessors })),
    ).toThrow();
  });

  it('accepts zero predecessors (root event)', () => {
    expect(() => AttestedEventSchema.parse(validEvent({ causal_predecessors: [] }))).not.toThrow();
  });

  it('rejects reliability above unsigned 16-bit', () => {
    expect(() => AttestedEventSchema.parse(validEvent({ source_reliability: 0x10000 }))).toThrow();
  });

  it('rejects reliability below zero', () => {
    expect(() => AttestedEventSchema.parse(validEvent({ source_reliability: -1 }))).toThrow();
  });

  it('rejects non-hex hash', () => {
    expect(() =>
      AttestedEventSchema.parse(validEvent({ payload_integrity: 'not-a-hash' })),
    ).toThrow();
  });

  it('rejects empty source_id', () => {
    expect(() => AttestedEventSchema.parse(validEvent({ source_id: '' }))).toThrow();
  });

  it('rejects negative sequence marker', () => {
    expect(() => AttestedEventSchema.parse(validEvent({ causal_sequence_marker: -1n }))).toThrow();
  });

  it('accepts each well-known event_type value', () => {
    for (const t of EVENT_TYPES) {
      expect(() => AttestedEventSchema.parse(validEvent({ event_type: t }))).not.toThrow();
    }
  });

  it('rejects unknown event_type', () => {
    expect(() =>
      AttestedEventSchema.parse(validEvent({ event_type: 'invalid' as 'user-generated' })),
    ).toThrow();
  });

  it('accepts each well-known chain_id', () => {
    for (const c of WELL_KNOWN_CHAINS) {
      expect(() => AttestedEventSchema.parse(validEvent({ chain_id: c }))).not.toThrow();
    }
  });

  it('accepts arbitrary chain_id strings (future-proofing)', () => {
    expect(() =>
      AttestedEventSchema.parse(validEvent({ chain_id: 'future-domain-chain' })),
    ).not.toThrow();
  });

  it('rejects empty chain_id', () => {
    expect(() => AttestedEventSchema.parse(validEvent({ chain_id: '' }))).toThrow();
  });
});

describe('AbsenceEntry — schema validation', () => {
  it('accepts a valid entry', () => {
    expect(() =>
      AbsenceEntrySchema.parse({
        expected_hash: validHash(7),
        window_start: 10n,
        window_end: 20n,
      }),
    ).not.toThrow();
  });

  it('rejects when window_end < window_start', () => {
    expect(() =>
      AbsenceEntrySchema.parse({
        expected_hash: validHash(7),
        window_start: 20n,
        window_end: 10n,
      }),
    ).toThrow();
  });

  it('accepts when window_end == window_start', () => {
    expect(() =>
      AbsenceEntrySchema.parse({
        expected_hash: validHash(7),
        window_start: 15n,
        window_end: 15n,
      }),
    ).not.toThrow();
  });
});

describe('AttestedEvent — leaf schemas', () => {
  it('HashSchema accepts 64 lowercase hex chars', () => {
    expect(() => HashSchema.parse('a'.repeat(64))).not.toThrow();
    expect(() => HashSchema.parse('A'.repeat(64))).toThrow();
    expect(() => HashSchema.parse('a'.repeat(63))).toThrow();
  });

  it('SourceIdSchema bounds', () => {
    expect(() => SourceIdSchema.parse('x')).not.toThrow();
    expect(() => SourceIdSchema.parse('x'.repeat(255))).not.toThrow();
    expect(() => SourceIdSchema.parse('x'.repeat(256))).toThrow();
    expect(() => SourceIdSchema.parse('')).toThrow();
  });

  it('SequenceMarkerSchema bounds', () => {
    expect(() => SequenceMarkerSchema.parse(0n)).not.toThrow();
    expect(() => SequenceMarkerSchema.parse(0xffffffffffffffffn)).not.toThrow();
    expect(() => SequenceMarkerSchema.parse(0xffffffffffffffffn + 1n)).toThrow();
  });

  it('ReliabilityWireSchema bounds (16-bit)', () => {
    expect(() => ReliabilityWireSchema.parse(0)).not.toThrow();
    expect(() => ReliabilityWireSchema.parse(0xffff)).not.toThrow();
    expect(() => ReliabilityWireSchema.parse(0x10000)).toThrow();
    expect(() => ReliabilityWireSchema.parse(0.5)).toThrow();
    expect(() => ReliabilityWireSchema.parse(-1)).toThrow();
  });

  it('AttestationSignatureSchema requires both signatures present', () => {
    expect(() =>
      AttestationSignatureSchema.parse({
        pq: new Uint8Array(),
        classical: new Uint8Array(),
      }),
    ).not.toThrow();
    expect(() =>
      AttestationSignatureSchema.parse({
        pq: new Uint8Array(),
      }),
    ).toThrow();
    expect(() =>
      AttestationSignatureSchema.parse({
        classical: new Uint8Array(),
      }),
    ).toThrow();
  });

  it('EventTypeSchema enumerates exactly four types', () => {
    expect(EVENT_TYPES).toEqual([
      'user-generated',
      'synthetic-derived',
      'system-operational',
      'validation-attestation',
    ]);
    for (const t of EVENT_TYPES) {
      expect(() => EventTypeSchema.parse(t)).not.toThrow();
    }
    expect(() => EventTypeSchema.parse('foo')).toThrow();
  });

  it('ChainIdSchema accepts non-empty strings, rejects empty and over-long', () => {
    expect(() => ChainIdSchema.parse('user-primary')).not.toThrow();
    expect(() => ChainIdSchema.parse('x')).not.toThrow();
    expect(() => ChainIdSchema.parse('x'.repeat(64))).not.toThrow();
    expect(() => ChainIdSchema.parse('x'.repeat(65))).toThrow();
    expect(() => ChainIdSchema.parse('')).toThrow();
  });

  it('WELL_KNOWN_CHAINS exports the Phase 0 sub-phase A through sub-phase E identifiers', () => {
    expect(WELL_KNOWN_CHAINS).toEqual([
      'user-primary',
      'reasoning-capture',
      'ai-interaction',
      'system-operational',
      'validation-pattern',
      'auth-events',
      'architecture-composition',
    ]);
  });
});
