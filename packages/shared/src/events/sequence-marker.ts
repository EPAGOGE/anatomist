// 64-bit unsigned causal sequence marker. See docs/adrs/0007-event-ordering.md.
// In TS this is `bigint`; on the wire it serialises to CBOR unsigned integer.
// A producer's marker is strictly greater than every predecessor's marker.

export type SequenceMarker = bigint & { readonly __sequenceMarker: true };

const MAX_U64 = 0xffffffffffffffffn;

function brand(value: bigint): SequenceMarker {
  return value as SequenceMarker;
}

export function makeSequenceMarker(value: number | bigint): SequenceMarker {
  const bi = typeof value === 'bigint' ? value : BigInt(value);
  if (bi < 0n) {
    throw new RangeError(`SequenceMarker cannot be negative: ${bi}`);
  }
  if (bi > MAX_U64) {
    throw new RangeError(`SequenceMarker exceeds 64-bit unsigned range: ${bi}`);
  }
  return brand(bi);
}

export function compareSequenceMarkers(a: SequenceMarker, b: SequenceMarker): -1 | 0 | 1 {
  if ((a as bigint) < (b as bigint)) return -1;
  if ((a as bigint) > (b as bigint)) return 1;
  return 0;
}

export function nextSequenceMarker(current: SequenceMarker): SequenceMarker {
  return makeSequenceMarker((current as bigint) + 1n);
}

export function maxSequenceMarker(markers: readonly SequenceMarker[]): SequenceMarker {
  if (markers.length === 0) {
    throw new RangeError('maxSequenceMarker on empty array');
  }
  let best = markers[0] as SequenceMarker;
  for (const m of markers) {
    if (compareSequenceMarkers(m, best) > 0) best = m;
  }
  return best;
}
