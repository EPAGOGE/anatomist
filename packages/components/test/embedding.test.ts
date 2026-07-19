import { describe, it, expect } from 'vitest';
import { ML_COMPONENTS, isCompatible } from '../src/index.js';

// E3-3d tests: embedding category gains PositionEmbedding and
// SegmentEmbedding alongside the renamed TokenEmbedding.

describe('TokenEmbedding (renamed from Embedding)', () => {
  const tok = ML_COMPONENTS.find((c) => c.id === 'ml.embedding')!;

  it('display name updated, id stable', () => {
    expect(tok.id).toBe('ml.embedding'); // unchanged for backwards-compat
    expect(tok.name).toBe('TokenEmbedding');
  });

  it('still in embedding category', () => {
    expect(tok.category).toBe('embedding');
  });

  it('codegen still emits nn.Embedding (no behavior change from rename)', () => {
    const ir = tok.codegen({ vocab_size: 50257, embed_dim: 768 });
    const init = ir.backends.pytorch!.init('self.embed');
    expect(init).toBe('self.embed = nn.Embedding(50257, 768)');
  });
});

describe('PositionEmbedding', () => {
  const pe = ML_COMPONENTS.find((c) => c.id === 'ml.position_embedding')!;
  const learnedPE = ML_COMPONENTS.find((c) => c.id === 'ml.learned_position_encoding')!;

  it('lives in the embedding category (not position-encoding)', () => {
    expect(pe).toBeDefined();
    expect(pe.category).toBe('embedding');
  });

  it('mechanically equivalent to LearnedPositionEncoding (intentional overlap)', () => {
    // Same trailing-stream signature, both add to running stream, both
    // emit nn.Embedding(max_seq_len, embed_dim). Listed in two
    // categories so users with different mental models find the one
    // they look for.
    expect(pe.inputs[0]!.signature({})).toEqual(learnedPE.inputs[0]!.signature({}));
    expect(pe.outputs[0]!.signature({})).toEqual(learnedPE.outputs[0]!.signature({}));
  });

  it('has BERT-convention default (max_seq_len=512)', () => {
    const maxLen = pe.properties.find((p) => p.id === 'max_seq_len')!;
    expect(maxLen.defaultValue).toBe(512);
  });

  it('PyTorch codegen emits nn.Embedding + positional add', () => {
    const ir = pe.codegen({ max_seq_len: 512, embed_dim: 768 });
    const init = ir.backends.pytorch!.init('self.pe');
    expect(init).toBe('self.pe = nn.Embedding(512, 768)');
    const fwd = ir.backends.pytorch!.forward('self.pe', { in: 'x' }, { out: 'y' });
    expect(fwd).toContain('_pos_ids = torch.arange(x.size(1)');
    expect(fwd).toContain('y = x + self.pe(_pos_ids).unsqueeze(0)');
  });
});

describe('SegmentEmbedding', () => {
  const seg = ML_COMPONENTS.find((c) => c.id === 'ml.segment_embedding')!;

  it('lives in the embedding category', () => {
    expect(seg).toBeDefined();
    expect(seg.category).toBe('embedding');
  });

  it('takes two inputs: running stream + segment_ids', () => {
    expect(seg.inputs).toHaveLength(2);
    const xs = seg.inputs.map((p) => p.id).sort();
    expect(xs).toEqual(['in', 'segment_ids']);
    const segIn = seg.inputs.find((p) => p.id === 'segment_ids')!;
    const sig = segIn.signature({});
    expect(sig.shape).toEqual(['batch', 'seq']);
    expect(sig.dtype).toBe('int64');
  });

  it('has BERT default (2 segments)', () => {
    const num = seg.properties.find((p) => p.id === 'num_segments')!;
    expect(num.defaultValue).toBe(2);
  });

  it('PyTorch codegen emits nn.Embedding(num_segments, embed_dim) + indexed add', () => {
    const ir = seg.codegen({ num_segments: 2, embed_dim: 768 });
    const init = ir.backends.pytorch!.init('self.seg');
    expect(init).toBe('self.seg = nn.Embedding(2, 768)');
    const fwd = ir.backends.pytorch!.forward(
      'self.seg',
      { in: 'x', segment_ids: 's' },
      { out: 'y' },
    );
    expect(fwd).toBe('y = x + self.seg(s)');
  });

  it('output signature matches Token+Position stream (composable in BERT stack)', () => {
    const segOut = seg.outputs[0]!.signature({});
    const peOut = ML_COMPONENTS.find(
      (c) => c.id === 'ml.position_embedding',
    )!.outputs[0]!.signature({});
    expect(isCompatible(segOut, peOut)).toBeNull();
  });
});
