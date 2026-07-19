// Canonical CBOR encoding for events. See docs/adrs/0005-event-encoding.md.
//
// cbor-x is the chosen library (strategic index + forward-design notes FIXED item).
// cbor-x doesn't enforce canonical encoding by default; this module wraps it
// with a recursive key-sort pass that produces deterministic output for any
// plain-object input.
//
// What canonical means here: two semantically-equal inputs produce identical
// byte sequences. The guarantee covers plain objects (keys sorted), arrays
// (order preserved), primitives (encoded directly), Uint8Array (encoded as
// byte string), and bigint (encoded as the smallest int type that fits).
//
// Anything beyond those (Maps, Sets, class instances, Dates) should be
// transformed into one of the supported types BEFORE encoding.

import { Encoder, Decoder } from 'cbor-x';

const encoder = new Encoder({
  useRecords: false,
  mapsAsObjects: true,
  bundleStrings: false,
  copyBuffers: true,
  largeBigIntToFloat: false,
});

const decoder = new Decoder({
  useRecords: false,
  mapsAsObjects: true,
  bundleStrings: false,
  copyBuffers: true,
  largeBigIntToFloat: false,
});

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sorted[k] = canonicalize(obj[k]);
  }
  return sorted;
}

export function encodeCanonicalCbor(value: unknown): Uint8Array {
  const canonical = canonicalize(value);
  return new Uint8Array(encoder.encode(canonical));
}

export function decodeCbor<T = unknown>(bytes: Uint8Array): T {
  return decoder.decode(bytes) as T;
}
