// Codegen helpers shared across the ML component definitions.
//
// Kept in their own module so attention.ts (E3-1), position-encoding.ts
// (E3-2), etc. can reuse them without duplication. The originals lived
// inline in ./index.ts when the ML domain had only six components;
// extracting them to a helper as the catalog expands.

/** PyTorch standard imports — every ML component needs at least these. */
export function nn(): readonly string[] {
  return ['import torch', 'import torch.nn as nn', 'import torch.nn.functional as F'];
}

/** Resolve a property value as a positive int with fallback. */
export function asInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** Resolve a property value as a string with fallback. */
export function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** Resolve a property value as a boolean with fallback. */
export function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Resolve a property value as a number (float ok) with fallback. */
export function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Python boolean literal: `True` / `False`. PyTorch nn.* constructors
 * accept these in their kwargs.
 */
export function pyBool(v: boolean): string {
  return v ? 'True' : 'False';
}

// =====================================================================
// Position-encoding configuration for self-attention variants.
//
// Per ADR-0028 (and E3-2 brief): RoPE and ALiBi are NOT standalone
// components. They modify attention computation inside the variant
// rather than adding to the embedding stream. So instead of a
// PositionEncoding component connecting between Embedding and Attention,
// the self-attention variants (MHA, MQA, GQA, Flash, SlidingWindow)
// expose a `position_encoding` property whose value selects 'none' /
// 'rope' / 'alibi'. Their codegen splices in the relevant Q/K rotation
// (RoPE) or attention-score bias (ALiBi) code via the helpers here.
//
// Absolute + Learned position encodings remain standalone components
// (./position-encoding.ts) because they DO add to the embedding stream
// and pass through unchanged to attention.
// =====================================================================

export type PositionEncodingChoice = 'none' | 'rope' | 'alibi';

/**
 * The standard PropertySpec for position_encoding. Every self-attention
 * variant adds this property; it controls the PE branch of codegen.
 *
 * Lives in the `position-encoding` UI group (per ADR-0033) — collapsed
 * by default since most users either don't use in-attention PE or set
 * it once and leave it. The inspector auto-expands when set.
 */
export function positionEncodingProperty() {
  return {
    id: 'position_encoding',
    label: 'Position encoding',
    kind: 'enum' as const,
    defaultValue: 'none' as string,
    choices: ['none', 'rope', 'alibi'] as readonly string[],
    group: 'position-encoding',
    description:
      'In-attention positional bias. RoPE rotates Q/K by position-dependent angles. ALiBi adds a linear bias to attention scores. None = use upstream additive PE (absolute/learned) or rely on relative ordering only.',
  };
}

/** RoPE base frequency property. Only meaningful when position_encoding=rope. */
export function ropeBaseProperty() {
  return {
    id: 'rope_base',
    label: 'RoPE base frequency',
    kind: 'float' as const,
    defaultValue: 10000.0,
    group: 'position-encoding',
    description:
      'Base for RoPE inverse-frequency computation (theta). 10000 is the original paper default; modern long-context models often use 500000 or higher.',
  };
}

/** The standard PropertyGroup for the position-encoding section on
 *  self-attention variants. Collapsed by default; auto-expands when
 *  the user picks a non-`none` PE. */
export function positionEncodingGroup() {
  return {
    id: 'position-encoding',
    label: 'Position encoding',
    description:
      'In-attention PE bias (RoPE / ALiBi). Standalone Absolute / Learned PE on the embedding stream is configured upstream.',
    defaultCollapsed: true,
  };
}

/** Fragments emitted by the position-encoding helper into attention codegen. */
export interface AttentionPEFragments {
  /** Constructor lines (rare — mostly RoPE base + ALiBi slope buffers). */
  readonly initLines: readonly string[];
  /**
   * Forward-body lines emitted AFTER Q/K are reshaped to [B, H, T, D]
   * and BEFORE the SDPA call. May mutate _q and _k in place (RoPE)
   * or define a bias tensor for the attn_mask arg (ALiBi).
   */
  readonly preAttnLines: readonly string[];
  /**
   * Expression to pass as `attn_mask=` to SDPA, or null when no mask
   * bias is needed. Callers that already have a window/causal mask
   * are responsible for combining it with this expression (typically
   * by adding the ALiBi bias to a -inf-shifted boolean mask).
   */
  readonly attnMaskExpr: string | null;
}

/**
 * Build PE fragments for a given choice. `varBase` is the attention
 * variant's `self.<alias>_N` prefix (e.g. `self.gqa_1`). `qVar` / `kVar`
 * are the local Python variable names holding the reshaped Q/K tensors
 * (typically `_q` and `_k` per the established codegen convention).
 * `numHeadsExpr` is a Python expression yielding the head count at
 * runtime (typically `_H`).
 */
export function attentionPositionEncoding(
  pe: PositionEncodingChoice,
  opts: {
    varBase: string;
    ropeBase: number;
    qVar: string;
    kVar: string;
    numHeadsExpr: string;
  },
): AttentionPEFragments {
  if (pe === 'none') {
    return { initLines: [], preAttnLines: [], attnMaskExpr: null };
  }
  if (pe === 'rope') {
    return ropeFragments(opts);
  }
  if (pe === 'alibi') {
    return alibiFragments(opts);
  }
  return { initLines: [], preAttnLines: [], attnMaskExpr: null };
}

function ropeFragments(opts: {
  varBase: string;
  ropeBase: number;
  qVar: string;
  kVar: string;
}): AttentionPEFragments {
  const { varBase, ropeBase, qVar, kVar } = opts;
  return {
    initLines: [`${varBase}_rope_base = ${ropeBase}`],
    preAttnLines: [
      `# RoPE: rotate Q and K by position-dependent angles.`,
      `_rope_D = ${qVar}.shape[-1]`,
      `_rope_T = ${qVar}.shape[2]`,
      `_rope_inv_freq = 1.0 / (${varBase}_rope_base ** (torch.arange(0, _rope_D, 2, device=${qVar}.device).float() / _rope_D))`,
      `_rope_pos = torch.arange(_rope_T, device=${qVar}.device).float()`,
      `_rope_freqs = torch.outer(_rope_pos, _rope_inv_freq)  # [T, D/2]`,
      `_rope_cos = _rope_freqs.cos()[None, None, :, :]`,
      `_rope_sin = _rope_freqs.sin()[None, None, :, :]`,
      `_q_even, _q_odd = ${qVar}[..., 0::2], ${qVar}[..., 1::2]`,
      `_k_even, _k_odd = ${kVar}[..., 0::2], ${kVar}[..., 1::2]`,
      `${qVar} = torch.stack([_q_even * _rope_cos - _q_odd * _rope_sin, _q_even * _rope_sin + _q_odd * _rope_cos], dim=-1).flatten(-2)`,
      `${kVar} = torch.stack([_k_even * _rope_cos - _k_odd * _rope_sin, _k_even * _rope_sin + _k_odd * _rope_cos], dim=-1).flatten(-2)`,
    ],
    attnMaskExpr: null,
  };
}

function alibiFragments(opts: { qVar: string; numHeadsExpr: string }): AttentionPEFragments {
  const { qVar, numHeadsExpr } = opts;
  return {
    initLines: [],
    preAttnLines: [
      `# ALiBi: per-head linear bias on attention scores.`,
      `_alibi_H = ${numHeadsExpr}`,
      `_alibi_T = ${qVar}.shape[2]`,
      `_alibi_slopes = (2.0 ** (-8.0 / _alibi_H)) ** torch.arange(1, _alibi_H + 1, device=${qVar}.device, dtype=${qVar}.dtype)`,
      `_alibi_pos = torch.arange(_alibi_T, device=${qVar}.device)`,
      `_alibi_rel = (_alibi_pos.unsqueeze(0) - _alibi_pos.unsqueeze(1)).to(${qVar}.dtype).abs()`,
      `_alibi_mask = (-_alibi_slopes.view(_alibi_H, 1, 1) * _alibi_rel.unsqueeze(0)).unsqueeze(0)  # [1, H, T, T]`,
    ],
    attnMaskExpr: '_alibi_mask',
  };
}
