import { describe, it, expect } from 'vitest';
import { ML_COMPONENTS, isCompatible, type TensorSignature } from '../src/index.js';

function comp(id: string) {
  const c = ML_COMPONENTS.find((x) => x.id === id);
  if (!c) throw new Error(`missing component: ${id}`);
  return c;
}

describe('AbsolutePositionEncoding (standalone, sinusoidal)', () => {
  const spec = comp('ml.absolute_position_encoding');

  it('is a "position-encoding" category, single-input single-output', () => {
    expect(spec.category).toBe('position-encoding');
    expect(spec.inputs).toHaveLength(1);
    expect(spec.outputs).toHaveLength(1);
  });

  it('passes embed_dim through unchanged (additive PE preserves shape)', () => {
    const inSig: TensorSignature = spec.inputs[0]!.signature({});
    const outSig: TensorSignature = spec.outputs[0]!.signature({});
    expect(inSig.shape).toEqual(['batch', 'seq', 'embed_dim']);
    expect(outSig.shape).toEqual(['batch', 'seq', 'embed_dim']);
    expect(isCompatible(inSig, outSig)).toBeNull();
  });

  it('codegen builds a sinusoidal table and adds to the embedding stream', () => {
    const ir = spec.codegen({ max_seq_len: 2048, embed_dim: 768 });
    const init = ir.backends.pytorch!.init('self.pe');
    expect(init).toContain('torch.zeros(2048, 768)');
    expect(init).toContain('torch.sin');
    expect(init).toContain('torch.cos');
    // math.log used for the inverse-frequency computation.
    expect(ir.backends.pytorch!.imports).toContain('import math');
    expect(init).toContain('math.log(10000.0)');
    const fwd = ir.backends.pytorch!.forward('self.pe', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('h = x + self.pe_pe[:, :x.size(1)]');
  });
});

describe('LearnedPositionEncoding (standalone, trainable)', () => {
  const spec = comp('ml.learned_position_encoding');

  it('codegen uses nn.Embedding indexed by position', () => {
    const ir = spec.codegen({ max_seq_len: 1024, embed_dim: 512 });
    const init = ir.backends.pytorch!.init('self.pos');
    expect(init).toContain('nn.Embedding(1024, 512)');
    const fwd = ir.backends.pytorch!.forward('self.pos', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('torch.arange(x.size(1)');
    expect(fwd).toContain('self.pos(_pos_ids)');
    expect(fwd).toContain('h = x + ');
  });
});

// =====================================================================
// RoPE / ALiBi as configuration on self-attention variants — ADR-0028.
// These tests verify that turning on position_encoding splices in the
// correct Q/K rotation (RoPE) or attention bias (ALiBi) code in each
// of the five self-attention variants.
// =====================================================================

const SELF_ATTN_VARIANTS = [
  'ml.multi_head_attention',
  'ml.multi_query_attention',
  'ml.grouped_query_attention',
  'ml.flash_attention',
  'ml.sliding_window_attention',
] as const;

describe('Attention variants — position_encoding + rope_base properties exposed', () => {
  it.each(SELF_ATTN_VARIANTS)('%s declares position_encoding + rope_base', (id) => {
    const spec = comp(id);
    const propIds = new Set(spec.properties.map((p) => p.id));
    expect(propIds).toContain('position_encoding');
    expect(propIds).toContain('rope_base');
    const pe = spec.properties.find((p) => p.id === 'position_encoding')!;
    expect(pe.defaultValue).toBe('none');
    expect(pe.kind).toBe('enum');
    expect(pe.choices).toEqual(['none', 'rope', 'alibi']);
  });
});

describe('Cross-attention has NO position_encoding property', () => {
  it('cross-attention skips PE config — multi-stream RoPE/ALiBi is ambiguous', () => {
    const spec = comp('ml.cross_attention');
    const propIds = new Set(spec.properties.map((p) => p.id));
    expect(propIds.has('position_encoding')).toBe(false);
    expect(propIds.has('rope_base')).toBe(false);
  });
});

describe('RoPE configuration emits rotation code', () => {
  // Pick GQA as a representative self-attention variant; the pattern
  // applies uniformly across the five.
  const spec = comp('ml.grouped_query_attention');

  it('init records the configured rope_base', () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      num_kv_heads: 4,
      dropout: 0.0,
      is_causal: true,
      position_encoding: 'rope',
      rope_base: 500000.0,
    });
    expect(ir.backends.pytorch!.init('self.gqa')).toContain('self.gqa_rope_base = 500000');
  });

  it('forward splices rotation BEFORE the SDPA call', () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      num_kv_heads: 4,
      dropout: 0.0,
      is_causal: true,
      position_encoding: 'rope',
      rope_base: 10000.0,
    });
    const fwd = ir.backends.pytorch!.forward('self.gqa', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('# RoPE: rotate Q and K by position-dependent angles.');
    expect(fwd).toContain('_rope_inv_freq');
    expect(fwd).toContain('_rope_cos');
    expect(fwd).toContain('_rope_sin');
    // Q and K both get rotated.
    expect(fwd).toMatch(/_q = torch\.stack\(\[/);
    expect(fwd).toMatch(/_k = torch\.stack\(\[/);
    // Rotation happens BEFORE the SDPA call.
    const ropeIdx = fwd.indexOf('# RoPE:');
    const sdpaIdx = fwd.indexOf('F.scaled_dot_product_attention');
    expect(ropeIdx).toBeLessThan(sdpaIdx);
    // is_causal is preserved (RoPE doesn't replace causal masking).
    expect(fwd).toContain('is_causal=True');
  });
});

describe('ALiBi configuration builds a per-head bias mask', () => {
  const spec = comp('ml.flash_attention');

  it('forward computes per-head slopes and a [1, H, T, T] bias tensor', () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      dropout: 0.0,
      is_causal: true,
      position_encoding: 'alibi',
      rope_base: 10000.0,
    });
    const fwd = ir.backends.pytorch!.forward('self.flash', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('# ALiBi: per-head linear bias on attention scores.');
    expect(fwd).toContain('_alibi_slopes');
    expect(fwd).toContain('_alibi_mask');
    // ALiBi mask is passed as attn_mask to SDPA. is_causal is dropped
    // because a float attn_mask and is_causal aren't jointly composable.
    expect(fwd).toContain('attn_mask=_alibi_mask');
    expect(fwd).not.toContain('is_causal=');
  });
});

describe('SlidingWindow + ALiBi combines window mask with bias', () => {
  const spec = comp('ml.sliding_window_attention');

  it('forward converts window boolean mask to float and adds ALiBi bias', () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      window_size: 1024,
      dropout: 0.0,
      position_encoding: 'alibi',
      rope_base: 10000.0,
    });
    const fwd = ir.backends.pytorch!.forward('self.swa', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain("_window_float = torch.where(_window_mask, 0.0, float('-inf'))");
    expect(fwd).toContain('_final_mask = _window_float + _alibi_mask');
    expect(fwd).toContain('attn_mask=_final_mask');
  });
});

describe('MHA branches between nn.MultiheadAttention and explicit SDPA', () => {
  const spec = comp('ml.multi_head_attention');

  it("PE='none' uses nn.MultiheadAttention (canonical)", () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      dropout: 0.1,
      position_encoding: 'none',
    });
    expect(ir.backends.pytorch!.init('self.attn')).toContain(
      'nn.MultiheadAttention(768, 12, dropout=0.1, batch_first=True)',
    );
    const fwd = ir.backends.pytorch!.forward('self.attn', { in: 'x' }, { out: 'h' });
    expect(fwd).toBe('h, _ = self.attn(x, x, x)');
  });

  it("PE='rope' switches to explicit Q/K/V projections + SDPA", () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      dropout: 0.0,
      position_encoding: 'rope',
      rope_base: 10000.0,
    });
    const init = ir.backends.pytorch!.init('self.attn');
    expect(init).toContain('self.attn_qkv = nn.Linear(768, 3 * 768)');
    expect(init).not.toContain('nn.MultiheadAttention');
    const fwd = ir.backends.pytorch!.forward('self.attn', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('F.scaled_dot_product_attention');
    expect(fwd).toContain('# RoPE');
  });
});
