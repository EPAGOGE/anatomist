// Tensor signatures for component port I/O.
//
// A signature is a (shape, dtype) pair that an edge in the canvas must
// satisfy at both ends. Connection validation uses `isCompatible` on
// each adjacent port pair; failures are surfaced as ghost-line errors
// in the UI with a human-readable reason.
//
// Shapes use NAMED-SYMBOLIC dimensions for Phase 0 sub-phase E (e.g.
// `[batch, seq, embed_dim]`). Concrete numeric dimensions are supported
// alongside names. A full symbolic algebra (constraint propagation,
// sympy-style) is captured optionality for a later tranche — the
// `compareDim` function is the seam where that lands.

import { z } from 'zod';

/**
 * Tensor element type. The wire representation is a closed enum;
 * future dtypes (bfloat8, complex64, etc.) join by enum extension and
 * carry forward through codegen without further schema work.
 *
 * Codegen backends are responsible for translating these to their
 * framework's equivalent (PyTorch: torch.float32, JAX: jnp.float32).
 */
export const DTYPES = ['float32', 'float16', 'bfloat16', 'int32', 'int64', 'bool'] as const;

export type DType = (typeof DTYPES)[number];

export const DTypeSchema = z.enum(DTYPES);

/**
 * One dimension of a tensor shape. Either:
 *   - A positive integer (concrete dimension)
 *   - A symbolic name (variable dimension carried through the graph)
 *
 * The symbolic name MUST match `[a-z][a-z0-9_]*`. Conventional names:
 *   batch, seq, embed_dim, num_heads, head_dim, vocab_size, hidden_dim
 *
 * Two named dimensions are compatible iff they share the same name.
 * Two concrete dimensions are compatible iff they have the same value.
 * A named and a concrete are compatible (the name binds to the value
 * downstream; Phase 0 sub-phase E doesn't propagate the binding yet —
 * that's the rabbit hole reserved for a follow-up tranche).
 */
export type Dim = number | string;

export const DimSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^[a-z][a-z0-9_]*$/, 'symbolic dim names use lowercase snake_case'),
]);

/**
 * A tensor signature. A port carries one of these.
 *
 * `shape` is a list of dimensions, leftmost = outermost. By convention
 * the batch dimension comes first (`[batch, ...]`). An empty shape is
 * a scalar.
 *
 * `dtype` is exact-match on connection (no implicit casts in Phase 0
 * sub-phase E — the user picks the type explicitly).
 */
export interface TensorSignature {
  readonly shape: readonly Dim[];
  readonly dtype: DType;
}

export const TensorSignatureSchema = z.object({
  shape: z.array(DimSchema),
  dtype: DTypeSchema,
});

/**
 * Compare two dimensions for compatibility. Returns null on match, or a
 * human-readable reason on mismatch (suitable for surfacing in the
 * connection-validation UI).
 *
 * Compatibility rules:
 *   - Both concrete: must be equal.
 *   - Both named: must be the same name.
 *   - One concrete, one named: compatible (the name will eventually
 *     resolve to the concrete value when propagation lands).
 */
export function compareDim(a: Dim, b: Dim): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? null : `dim mismatch: ${a} vs ${b}`;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b ? null : `dim name mismatch: ${a} vs ${b}`;
  }
  // Mixed concrete + named — accept for now.
  return null;
}

/**
 * Check whether a source signature can flow into a target signature.
 *
 * Rank (shape length) must match. Each dimension must be pairwise
 * compatible. Dtypes must match exactly.
 *
 * Returns null on compatible, or a human-readable reason on mismatch.
 */
export function isCompatible(source: TensorSignature, target: TensorSignature): string | null {
  if (source.dtype !== target.dtype) {
    return `dtype: ${source.dtype} cannot flow into ${target.dtype}`;
  }
  if (source.shape.length !== target.shape.length) {
    return `rank: ${source.shape.length}D cannot flow into ${target.shape.length}D`;
  }
  for (let i = 0; i < source.shape.length; i++) {
    const diff = compareDim(source.shape[i]!, target.shape[i]!);
    if (diff) {
      return `dim ${i}: ${diff}`;
    }
  }
  return null;
}

/**
 * Pretty-print a signature for tooltips and error messages.
 *   `{ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }`
 *   → `Tensor[batch,seq,embed_dim:float32]`
 */
export function formatSignature(sig: TensorSignature): string {
  const dims = sig.shape.length === 0 ? '' : `[${sig.shape.join(',')}]`;
  return `Tensor${dims}:${sig.dtype}`;
}
