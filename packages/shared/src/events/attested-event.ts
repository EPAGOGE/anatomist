// AttestedEvent — in-memory and on-wire shape for a single event in the
// platform's provenance ledger. Field names match the upstream architectural
// specification under neutral naming per docs/adrs/0009-terminology-hygiene.md.
//
// Every event carries:
//   - chain_id: which chain it belongs to (multi-chain operation from Phase 0)
//   - event_type: origin/trust category (user-generated, synthetic-derived,
//     system-operational, validation-attestation)
// See docs/adrs/0011-chain-taxonomy.md for the rationale.

import { z } from 'zod';
import { ChainIdSchema, EventTypeSchema } from './chain-id.js';

const HEX_64 = /^[0-9a-f]{64}$/;

export const HashSchema = z.string().regex(HEX_64, {
  message: 'expected 64-character lowercase hex digest',
});
export type Hash = z.infer<typeof HashSchema>;

export const SourceIdSchema = z.string().min(1).max(255);
export type SourceId = z.infer<typeof SourceIdSchema>;

// SequenceMarker on the wire is an unsigned 64-bit integer; in TS it's a
// bigint. CBOR may decode small bigints as JS number, so we use coerce.bigint()
// to normalize back to bigint after wire decode.
export const SequenceMarkerSchema = z.coerce.bigint().min(0n).max(0xffffffffffffffffn);

// Reliability scalar in wire form: unsigned 16-bit integer.
// See docs/adrs/0006-numerical-representation.md.
// [0, 65535] maps to [0.0, 1.0]; granularity 1/65535 ≈ 1.526e-5.
export const ReliabilityWireSchema = z.number().int().min(0).max(0xffff);

// An expected-but-not-observed unit within a window. The window bounds are
// themselves sequence markers; the unit identifier is a hash of the expected
// payload. This is the absence-evidence required on every event.
export const AbsenceEntrySchema = z
  .object({
    expected_hash: HashSchema,
    window_start: SequenceMarkerSchema,
    window_end: SequenceMarkerSchema,
  })
  .refine((v) => v.window_end >= v.window_start, {
    message: 'window_end must be >= window_start',
  });
export type AbsenceEntry = z.infer<typeof AbsenceEntrySchema>;

export const AbsenceSetDeltaSchema = z.array(AbsenceEntrySchema);
export type AbsenceSetDelta = z.infer<typeof AbsenceSetDeltaSchema>;

// Hybrid attestation: both signatures MUST be present.
// See docs/adrs/0003-attestation-primitives.md.
export const AttestationSignatureSchema = z.object({
  pq: z.instanceof(Uint8Array), // ML-DSA-65 signature, ~3309 bytes
  classical: z.instanceof(Uint8Array), // Ed25519 signature, 64 bytes
});
export type AttestationSignature = z.infer<typeof AttestationSignatureSchema>;

export const GroundTruthIndicatorSchema = z.string().optional();

const MAX_PREDECESSORS = 10;

export const AttestedEventSchema = z.object({
  version: z.literal(1),
  chain_id: ChainIdSchema,
  event_type: EventTypeSchema,
  source_id: SourceIdSchema,
  causal_predecessors: z.array(HashSchema).max(MAX_PREDECESSORS),
  absence_set_delta: AbsenceSetDeltaSchema,
  source_reliability: ReliabilityWireSchema,
  causal_sequence_marker: SequenceMarkerSchema,
  ground_truth_calibration_indicator: GroundTruthIndicatorSchema,
  attestation_signature: AttestationSignatureSchema,
  payload_integrity: HashSchema,
});
export type AttestedEvent = z.infer<typeof AttestedEventSchema>;

export const ATTESTED_EVENT_VERSION = 1 as const;
export const MAX_PREDECESSOR_COUNT = MAX_PREDECESSORS;
