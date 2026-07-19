import { describe, it, expect } from 'vitest';
import { ML_COMPONENTS, isCompatible } from '../src/index.js';

// E3-3a tests: RMSNorm joins LayerNorm in the normalization category.

describe('RMSNorm', () => {
  const rms = ML_COMPONENTS.find((c) => c.id === 'ml.rms_norm')!;
  const layerNorm = ML_COMPONENTS.find((c) => c.id === 'ml.layer_norm')!;
  const embedding = ML_COMPONENTS.find((c) => c.id === 'ml.embedding')!;

  it('lives in the normalization category alongside LayerNorm', () => {
    expect(rms).toBeDefined();
    expect(rms.category).toBe('normalization');
    expect(layerNorm.category).toBe('normalization');
  });

  it('has Llama-convention defaults (eps=1e-6)', () => {
    const eps = rms.properties.find((p) => p.id === 'eps')!;
    expect(eps.defaultValue).toBe(1e-6);
    // Sanity-check that LayerNorm still defaults to 1e-5 — we don't want
    // the two norms to drift into the same defaults silently.
    const lnEps = layerNorm.properties.find((p) => p.id === 'eps')!;
    expect(lnEps.defaultValue).toBe(1e-5);
  });

  it('preserves shape [batch, seq, embed_dim] float32 through normalization', () => {
    const inSig = rms.inputs[0]!.signature({});
    const outSig = rms.outputs[0]!.signature({});
    expect(inSig).toEqual({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' });
    expect(outSig).toEqual({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' });
  });

  it('Embedding → RMSNorm signatures compatible (Llama-style stack)', () => {
    const embOut = embedding.outputs[0]!.signature({ vocab_size: 32000, embed_dim: 4096 });
    const rmsIn = rms.inputs[0]!.signature({ normalized_shape: 4096 });
    expect(isCompatible(embOut, rmsIn)).toBeNull();
  });

  it('PyTorch codegen emits nn.RMSNorm with explicit eps', () => {
    const ir = rms.codegen({ normalized_shape: 4096, eps: 1e-6 });
    expect(ir.backends.pytorch).toBeDefined();
    const init = ir.backends.pytorch!.init('self.rms');
    expect(init).toContain('nn.RMSNorm(4096');
    expect(init).toContain('eps=0.000001');
    const fwd = ir.backends.pytorch!.forward('self.rms', { in: 'x' }, { out: 'y' });
    expect(fwd).toBe('y = self.rms(x)');
  });

  it('codegen tolerates missing properties (falls back to 768 / 1e-6)', () => {
    const ir = rms.codegen({});
    const init = ir.backends.pytorch!.init('self.rms');
    expect(init).toContain('nn.RMSNorm(768');
    expect(init).toContain('eps=0.000001');
  });
});
