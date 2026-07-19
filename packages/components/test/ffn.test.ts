import { describe, it, expect } from 'vitest';
import { ML_COMPONENTS } from '../src/index.js';

// E3-3c tests: GatedFFN (SwiGLU-family) + MoEFFN.

describe('GatedFFN', () => {
  const gated = ML_COMPONENTS.find((c) => c.id === 'ml.gated_ffn')!;

  it('lives in the ffn category alongside FeedForward', () => {
    expect(gated).toBeDefined();
    expect(gated.category).toBe('ffn');
  });

  it('has Llama-convention defaults (silu activation, bias=False, 4096→11008)', () => {
    const act = gated.properties.find((p) => p.id === 'activation')!;
    const bias = gated.properties.find((p) => p.id === 'bias')!;
    const embed = gated.properties.find((p) => p.id === 'embed_dim')!;
    const hidden = gated.properties.find((p) => p.id === 'hidden_dim')!;
    expect(act.defaultValue).toBe('silu');
    expect(bias.defaultValue).toBe(false);
    expect(embed.defaultValue).toBe(4096);
    expect(hidden.defaultValue).toBe(11008);
  });

  it('PyTorch codegen emits three projections with no bias by default', () => {
    const ir = gated.codegen({
      embed_dim: 4096,
      hidden_dim: 11008,
      activation: 'silu',
      bias: false,
    });
    const init = ir.backends.pytorch!.init('self.ffn');
    expect(init).toContain('self.ffn_gate = nn.Linear(4096, 11008, bias=False)');
    expect(init).toContain('self.ffn_up = nn.Linear(4096, 11008, bias=False)');
    expect(init).toContain('self.ffn_down = nn.Linear(11008, 4096, bias=False)');
  });

  it('PyTorch forward emits down(act(gate(x)) * up(x)) — SwiGLU by default', () => {
    const ir = gated.codegen({ activation: 'silu' });
    const fwd = ir.backends.pytorch!.forward('self.ffn', { in: 'x' }, { out: 'y' });
    expect(fwd).toBe('y = self.ffn_down(F.silu(self.ffn_gate(x)) * self.ffn_up(x))');
  });

  it('activation choice switches the GLU variant (GeGLU)', () => {
    const ir = gated.codegen({ activation: 'gelu' });
    const fwd = ir.backends.pytorch!.forward('self.ffn', { in: 'x' }, { out: 'y' });
    expect(fwd).toContain('F.gelu(self.ffn_gate(x))');
  });

  it('activation choice ReGLU works', () => {
    const ir = gated.codegen({ activation: 'relu' });
    const fwd = ir.backends.pytorch!.forward('self.ffn', { in: 'x' }, { out: 'y' });
    expect(fwd).toContain('F.relu(self.ffn_gate(x))');
  });

  it('bias=true emits bias=True on all three projections', () => {
    const ir = gated.codegen({ embed_dim: 768, hidden_dim: 2048, activation: 'silu', bias: true });
    const init = ir.backends.pytorch!.init('self.ffn');
    expect(init).toContain('bias=True');
    expect(init).not.toContain('bias=False');
  });
});

describe('MoEFFN', () => {
  const moe = ML_COMPONENTS.find((c) => c.id === 'ml.moe_ffn')!;

  it('lives in the ffn category', () => {
    expect(moe).toBeDefined();
    expect(moe.category).toBe('ffn');
  });

  it('has Mixtral-convention defaults (8 experts, top-2, hidden 14336)', () => {
    const n = moe.properties.find((p) => p.id === 'num_experts')!;
    const k = moe.properties.find((p) => p.id === 'top_k')!;
    const hidden = moe.properties.find((p) => p.id === 'hidden_dim')!;
    expect(n.defaultValue).toBe(8);
    expect(k.defaultValue).toBe(2);
    expect(hidden.defaultValue).toBe(14336);
  });

  it('exposes capacity_factor (informational in this codegen)', () => {
    const cap = moe.properties.find((p) => p.id === 'capacity_factor')!;
    expect(cap).toBeDefined();
    expect(cap.defaultValue).toBe(1.25);
  });

  it('PyTorch codegen emits router + per-expert ModuleList', () => {
    const ir = moe.codegen({ embed_dim: 4096, hidden_dim: 14336, num_experts: 8, top_k: 2 });
    const init = ir.backends.pytorch!.init('self.moe');
    expect(init).toContain('self.moe_router = nn.Linear(4096, 8, bias=False)');
    expect(init).toContain('self.moe_experts_up = nn.ModuleList([nn.Linear(4096, 14336');
    expect(init).toContain('for _ in range(8)');
    expect(init).toContain('self.moe_num_experts = 8');
    expect(init).toContain('self.moe_top_k = 2');
  });

  it('PyTorch forward implements top-k routing + per-expert dispatch', () => {
    const ir = moe.codegen({ activation: 'silu' });
    const fwd = ir.backends.pytorch!.forward('self.moe', { in: 'x' }, { out: 'y' });
    expect(fwd).toContain('self.moe_router(_moe_flat)');
    expect(fwd).toContain('topk(self.moe_top_k');
    expect(fwd).toContain('softmax(dim=-1)');
    // Per-expert loop with dispatch
    expect(fwd).toContain('for _e_i in range(self.moe_num_experts)');
    expect(fwd).toContain('F.silu(self.moe_experts_up[_e_i]');
    // Final reshape back to [B, T, E]
    expect(fwd).toContain('y = _moe_out.reshape(_moe_B, _moe_T, _moe_E)');
  });

  it('activation choice plumbs through to expert FFNs', () => {
    const ir = moe.codegen({ activation: 'gelu' });
    const fwd = ir.backends.pytorch!.forward('self.moe', { in: 'x' }, { out: 'y' });
    expect(fwd).toContain('F.gelu(self.moe_experts_up[_e_i]');
  });
});
