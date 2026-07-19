import { describe, it, expect } from 'vitest';
import { ML_COMPONENTS, isCompatible, type TensorSignature } from '../src/index.js';

function comp(id: string) {
  const c = ML_COMPONENTS.find((x) => x.id === id);
  if (!c) throw new Error(`missing component: ${id}`);
  return c;
}

describe('MultiQueryAttention (MQA)', () => {
  const spec = comp('ml.multi_query_attention');

  it('has the right shape: 1 input port, 1 output port, expected properties', () => {
    expect(spec.inputs).toHaveLength(1);
    expect(spec.outputs).toHaveLength(1);
    const props = new Set(spec.properties.map((p) => p.id));
    expect(props).toContain('embed_dim');
    expect(props).toContain('num_heads');
    expect(props).toContain('dropout');
    expect(props).toContain('is_causal');
  });

  it('port signatures are [batch, seq, embed_dim] float32', () => {
    const inSig: TensorSignature = spec.inputs[0]!.signature({});
    const outSig: TensorSignature = spec.outputs[0]!.signature({});
    expect(inSig.shape).toEqual(['batch', 'seq', 'embed_dim']);
    expect(outSig.shape).toEqual(['batch', 'seq', 'embed_dim']);
    expect(inSig.dtype).toBe('float32');
    expect(isCompatible(outSig, inSig)).toBeNull();
  });

  it('codegen emits shared-K shared-V projections sized to head_dim', () => {
    const ir = spec.codegen({ embed_dim: 768, num_heads: 12, dropout: 0.1, is_causal: false });
    const init = ir.backends.pytorch!.init('self.attn');
    // Q projects to full embed_dim.
    expect(init).toContain('self.attn_q = nn.Linear(768, 768)');
    // K and V project to head_dim only — that's the MQA economy.
    expect(init).toContain('self.attn_k = nn.Linear(768, 768 // 12)');
    expect(init).toContain('self.attn_v = nn.Linear(768, 768 // 12)');
    expect(init).toContain('self.attn_proj = nn.Linear(768, 768)');

    const fwd = ir.backends.pytorch!.forward('self.attn', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('F.scaled_dot_product_attention');
    expect(fwd).toContain('dropout_p=0.1');
    expect(fwd).toContain('is_causal=False');
    expect(fwd).toContain('h = self.attn_proj');
  });
});

describe('GroupedQueryAttention (GQA)', () => {
  const spec = comp('ml.grouped_query_attention');

  it('exposes num_kv_heads separate from num_heads', () => {
    const props = new Set(spec.properties.map((p) => p.id));
    expect(props).toContain('num_kv_heads');
    expect(props).toContain('num_heads');
  });

  it('codegen sizes K/V to num_kv_heads × head_dim and repeats to match num_heads', () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      num_kv_heads: 4,
      dropout: 0,
      is_causal: true,
    });
    const init = ir.backends.pytorch!.init('self.attn');
    expect(init).toContain('nn.Linear(768, 4 * (768 // 12))');
    const fwd = ir.backends.pytorch!.forward('self.attn', { in: 'x' }, { out: 'h' });
    // GQA's distinguishing operation: repeat KV heads to broadcast.
    expect(fwd).toContain('repeat_interleave');
    expect(fwd).toContain('is_causal=True');
  });
});

describe('FlashAttention', () => {
  const spec = comp('ml.flash_attention');

  it('default is causal (decoder-only convention)', () => {
    const causal = spec.properties.find((p) => p.id === 'is_causal');
    expect(causal?.defaultValue).toBe(true);
  });

  it('codegen uses fused QKV projection + SDPA', () => {
    const ir = spec.codegen({ embed_dim: 768, num_heads: 12, dropout: 0.0, is_causal: true });
    const init = ir.backends.pytorch!.init('self.attn');
    // FlashAttention fuses Q/K/V into one Linear of 3×embed_dim.
    expect(init).toContain('nn.Linear(768, 3 * 768)');
    const fwd = ir.backends.pytorch!.forward('self.attn', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('F.scaled_dot_product_attention');
    expect(fwd).toContain('is_causal=True');
  });
});

describe('SlidingWindowAttention', () => {
  const spec = comp('ml.sliding_window_attention');

  it('exposes window_size', () => {
    const window = spec.properties.find((p) => p.id === 'window_size');
    expect(window).toBeDefined();
    expect(window!.defaultValue).toBe(4096);
  });

  it('codegen builds a banded window mask and passes attn_mask to SDPA', () => {
    const ir = spec.codegen({
      embed_dim: 768,
      num_heads: 12,
      window_size: 256,
      dropout: 0.0,
    });
    const init = ir.backends.pytorch!.init('self.attn');
    expect(init).toContain('self.attn_window = 256');
    const fwd = ir.backends.pytorch!.forward('self.attn', { in: 'x' }, { out: 'h' });
    expect(fwd).toContain('attn_mask=_window_mask');
    // Banded mask construction.
    expect(fwd).toContain('< _W');
    // No is_causal flag — the window mask subsumes it.
    expect(fwd).not.toContain('is_causal=');
  });
});

describe('CrossAttention', () => {
  const spec = comp('ml.cross_attention');

  it('has TWO input ports (query + key_value) — multi-input pattern', () => {
    expect(spec.inputs).toHaveLength(2);
    const portIds = spec.inputs.map((p) => p.id).sort();
    expect(portIds).toEqual(['key_value', 'query']);
  });

  it('query and key_value can have different seq dims', () => {
    const q = spec.inputs.find((p) => p.id === 'query')!.signature({});
    const kv = spec.inputs.find((p) => p.id === 'key_value')!.signature({});
    expect(q.shape).toEqual(['batch', 'seq_q', 'embed_dim']);
    expect(kv.shape).toEqual(['batch', 'seq_kv', 'embed_dim']);
    // Output sequence dim matches query, not key_value (cross-attn invariant).
    const out = spec.outputs[0]!.signature({});
    expect(out.shape).toEqual(['batch', 'seq_q', 'embed_dim']);
  });

  it('codegen uses nn.MultiheadAttention with separate q and shared kv', () => {
    const ir = spec.codegen({ embed_dim: 1024, num_heads: 16, dropout: 0.1 });
    const init = ir.backends.pytorch!.init('self.cross');
    expect(init).toContain('nn.MultiheadAttention(1024, 16, dropout=0.1, batch_first=True)');
    const fwd = ir.backends.pytorch!.forward(
      'self.cross',
      { query: 'q_state', key_value: 'kv_state' },
      { out: 'h' },
    );
    // q from `query`, k+v both from `key_value`.
    expect(fwd).toContain('self.cross(q_state, kv_state, kv_state)');
    expect(fwd).toContain('h, _ =');
  });
});

describe('Attention variants — cross-cutting invariants', () => {
  const variantIds = [
    'ml.multi_query_attention',
    'ml.grouped_query_attention',
    'ml.flash_attention',
    'ml.sliding_window_attention',
    'ml.cross_attention',
  ];

  it('all attention variants are in the "attention" category and "ml" domain', () => {
    for (const id of variantIds) {
      const c = comp(id);
      expect(c.category).toBe('attention');
      expect(c.domain).toBe('ml');
    }
  });

  it('all attention variants ship a pytorch codegen fragment', () => {
    for (const id of variantIds) {
      const c = comp(id);
      // Use the property defaults so we exercise the codegen with realistic values.
      const props = Object.fromEntries(c.properties.map((p) => [p.id, p.defaultValue] as const));
      const ir = c.codegen(props);
      expect(ir.backends.pytorch).toBeDefined();
      // init may be empty (e.g. for nodes with no constructor lines), so
      // we only assert that init/forward are callable functions.
      expect(typeof ir.backends.pytorch!.init).toBe('function');
      expect(typeof ir.backends.pytorch!.forward).toBe('function');
    }
  });
});
