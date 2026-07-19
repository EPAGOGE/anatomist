// Reliability scalar: float64 in [0, 1] internally, 16-bit fixed-point on the
// wire. See docs/adrs/0006-numerical-representation.md.
//
// Wire format: unsigned 16-bit integer where 0 → 0.0 and 65535 → 1.0.
// Granularity is 1/65535 ≈ 1.526 × 10⁻⁵.
//
// Float64 internal representation has ~15-17 significant decimal digits — far
// more precision than the wire format. The strict inequality properties that
// the aggregation operators must satisfy hold in float64 across the full
// open interval (0, 1).

declare const RELIABILITY_BRAND: unique symbol;

export type Reliability = number & { readonly [RELIABILITY_BRAND]: true };

const WIRE_SCALE = 0xffff; // 65535
export const RELIABILITY_WIRE_MAX = WIRE_SCALE;

function brand(value: number): Reliability {
  return value as Reliability;
}

export function makeReliability(value: number): Reliability {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Reliability must be finite, got ${value}`);
  }
  if (value < 0 || value > 1) {
    throw new RangeError(`Reliability must be in [0, 1], got ${value}`);
  }
  return brand(value);
}

export const ZERO: Reliability = brand(0);
export const ONE: Reliability = brand(1);

export function clampToUnit(value: number): Reliability {
  if (!Number.isFinite(value)) {
    throw new RangeError(`clampToUnit on non-finite: ${value}`);
  }
  if (value <= 0) return ZERO;
  if (value >= 1) return ONE;
  return brand(value);
}

// Wire encoding: [0, 1] -> [0, 65535] uint16.
// Math.round produces nearest-integer; ties round half-to-even on float64.
export function toWireU16(r: Reliability): number {
  return Math.round((r as number) * WIRE_SCALE);
}

export function fromWireU16(u16: number): Reliability {
  if (!Number.isInteger(u16) || u16 < 0 || u16 > WIRE_SCALE) {
    throw new RangeError(`fromWireU16 out-of-range: ${u16}`);
  }
  return brand(u16 / WIRE_SCALE);
}
