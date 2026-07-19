import { describe, it, expect } from 'vitest';
import {
  ComponentRegistry,
  loadMlDomain,
  ML_COMPONENTS,
  isCompatible,
  formatSignature,
  compareDim,
  type TensorSignature,
} from '../src/index.js';

describe('tensor compatibility', () => {
  it('matching concrete dims compatible, mismatched not', () => {
    const a: TensorSignature = { shape: [4, 128], dtype: 'float32' };
    const b: TensorSignature = { shape: [4, 128], dtype: 'float32' };
    const c: TensorSignature = { shape: [4, 256], dtype: 'float32' };
    expect(isCompatible(a, b)).toBeNull();
    expect(isCompatible(a, c)).toMatch(/dim 1/);
  });

  it('matching named dims compatible', () => {
    const a: TensorSignature = { shape: ['batch', 'seq'], dtype: 'int64' };
    const b: TensorSignature = { shape: ['batch', 'seq'], dtype: 'int64' };
    expect(isCompatible(a, b)).toBeNull();
  });

  it('different names on same position incompatible', () => {
    const a: TensorSignature = { shape: ['batch', 'seq'], dtype: 'int64' };
    const b: TensorSignature = { shape: ['batch', 'tokens'], dtype: 'int64' };
    expect(isCompatible(a, b)).toMatch(/dim 1: dim name mismatch/);
  });

  it('mixed concrete + named accepted (defer to propagation)', () => {
    expect(compareDim(4, 'batch')).toBeNull();
    expect(compareDim('batch', 4)).toBeNull();
  });

  it('dtype mismatch detected', () => {
    const a: TensorSignature = { shape: ['batch'], dtype: 'float32' };
    const b: TensorSignature = { shape: ['batch'], dtype: 'int64' };
    expect(isCompatible(a, b)).toMatch(/dtype/);
  });

  it('rank mismatch detected', () => {
    const a: TensorSignature = { shape: ['batch'], dtype: 'float32' };
    const b: TensorSignature = { shape: ['batch', 'seq'], dtype: 'float32' };
    expect(isCompatible(a, b)).toMatch(/rank/);
  });

  it('formats signatures legibly', () => {
    expect(formatSignature({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' })).toBe(
      'Tensor[batch,seq,embed_dim]:float32',
    );
    expect(formatSignature({ shape: [], dtype: 'bool' })).toBe('Tensor:bool');
  });
});

describe('component registry', () => {
  it('register/get/has/list', () => {
    const reg = new ComponentRegistry();
    expect(reg.list()).toEqual([]);
    loadMlDomain(reg);
    expect(reg.list()).toHaveLength(21);
    expect(reg.has('ml.embedding')).toBe(true);
    expect(reg.has('ml.does_not_exist')).toBe(false);
    expect(reg.require('ml.multi_head_attention').name).toBe('MultiHeadAttention');
    // E3-3d renamed the display name from "Embedding" to "TokenEmbedding".
    // The id `ml.embedding` is unchanged so saved architectures still load.
    expect(reg.require('ml.embedding').name).toBe('TokenEmbedding');
  });

  it('throws on duplicate register', () => {
    const reg = new ComponentRegistry();
    loadMlDomain(reg);
    expect(() => loadMlDomain(reg)).toThrow(/already registered/);
  });

  it('listByDomain isolates to one domain', () => {
    const reg = new ComponentRegistry();
    loadMlDomain(reg);
    const ml = reg.listByDomain('ml');
    expect(ml).toHaveLength(21);
    expect(reg.listByDomain('eng')).toHaveLength(0);
  });
});

describe('ML primitives', () => {
  it('all twenty-one expected primitives are exported (6 foundation + 5 attention + 2 PE + 1 norm + 3 activation + 2 ffn + 2 embedding-variants)', () => {
    const ids = ML_COMPONENTS.map((c) => c.id).sort();
    expect(ids).toEqual([
      'ml.absolute_position_encoding',
      'ml.cross_attention',
      'ml.embedding',
      'ml.feedforward',
      'ml.flash_attention',
      'ml.gated_ffn',
      'ml.gelu',
      'ml.grouped_query_attention',
      'ml.input',
      'ml.layer_norm',
      'ml.learned_position_encoding',
      'ml.moe_ffn',
      'ml.multi_head_attention',
      'ml.multi_query_attention',
      'ml.output',
      'ml.position_embedding',
      'ml.relu',
      'ml.rms_norm',
      'ml.segment_embedding',
      'ml.silu',
      'ml.sliding_window_attention',
    ]);
  });

  it('Input output signature reflects the shape property', () => {
    const input = ML_COMPONENTS.find((c) => c.id === 'ml.input')!;
    const sig = input.outputs[0]!.signature({ shape: 'batch,seq,4', dtype: 'float32' });
    expect(sig.shape).toEqual(['batch', 'seq', 4]);
    expect(sig.dtype).toBe('float32');
  });

  it('Embedding output is [batch,seq,embed_dim] float32', () => {
    const emb = ML_COMPONENTS.find((c) => c.id === 'ml.embedding')!;
    const sig = emb.outputs[0]!.signature({ vocab_size: 50257, embed_dim: 768 });
    expect(sig.shape).toEqual(['batch', 'seq', 'embed_dim']);
    expect(sig.dtype).toBe('float32');
  });

  it('Embedding → LayerNorm signatures compatible', () => {
    const emb = ML_COMPONENTS.find((c) => c.id === 'ml.embedding')!;
    const norm = ML_COMPONENTS.find((c) => c.id === 'ml.layer_norm')!;
    const out = emb.outputs[0]!.signature({ vocab_size: 50257, embed_dim: 768 });
    const in_ = norm.inputs[0]!.signature({ normalized_shape: 768 });
    expect(isCompatible(out, in_)).toBeNull();
  });

  it('PyTorch codegen for embedding emits nn.Embedding', () => {
    const emb = ML_COMPONENTS.find((c) => c.id === 'ml.embedding')!;
    const ir = emb.codegen({ vocab_size: 32000, embed_dim: 512 });
    expect(ir.backends.pytorch).toBeDefined();
    const init = ir.backends.pytorch!.init('self.emb');
    expect(init).toContain('nn.Embedding(32000, 512)');
    const fwd = ir.backends.pytorch!.forward('self.emb', { tokens: 'x' }, { out: 'h' });
    expect(fwd).toContain('h = self.emb(x)');
  });

  it('PyTorch codegen for MHA emits batch_first=True', () => {
    const mha = ML_COMPONENTS.find((c) => c.id === 'ml.multi_head_attention')!;
    const ir = mha.codegen({ embed_dim: 768, num_heads: 12, dropout: 0.1 });
    const init = ir.backends.pytorch!.init('self.attn');
    expect(init).toContain('nn.MultiheadAttention(768, 12');
    expect(init).toContain('batch_first=True');
  });

  it('PyTorch codegen for FF picks activation function', () => {
    const ff = ML_COMPONENTS.find((c) => c.id === 'ml.feedforward')!;
    const irGelu = ff.codegen({ embed_dim: 768, hidden_dim: 3072, activation: 'gelu', bias: true });
    expect(irGelu.backends.pytorch!.forward('self.ff', { in: 'x' }, { out: 'y' })).toContain(
      'F.gelu',
    );
    const irRelu = ff.codegen({
      embed_dim: 768,
      hidden_dim: 3072,
      activation: 'relu',
      bias: false,
    });
    expect(irRelu.backends.pytorch!.init('self.ff')).toContain('bias=False');
    expect(irRelu.backends.pytorch!.forward('self.ff', { in: 'x' }, { out: 'y' })).toContain(
      'F.relu',
    );
  });

  it('Output codegen emits a return statement', () => {
    const out = ML_COMPONENTS.find((c) => c.id === 'ml.output')!;
    const ir = out.codegen({});
    expect(ir.backends.pytorch!.forward('self.out', { in: 'h' }, {})).toBe('return h');
  });
});
