// FFN variants — Phase 0 sub-phase E, tranche E3-3c.
//
// Two new feedforward variants joining the existing FeedForward
// (./index.ts) in the `ffn` category:
//
//   - GatedFFN: SwiGLU-family architecture. Three projections instead
//     of two — a gate path, an up path, and a down path. Combines as
//     `down(act(gate(x)) * up(x))`. Used by Llama, Mistral, Qwen,
//     Gemma. The activation choice picks which "GLU" you get:
//       - silu  → SwiGLU (Llama default)
//       - gelu  → GeGLU
//       - relu  → ReGLU
//
//   - MoEFFN: Mixture-of-Experts feedforward. Routes each token to a
//     subset of experts via a learned router; experts are independent
//     FFNs combined by router-assigned weights. Used by Mixtral,
//     DeepSeek-MoE, Switch Transformer.
//
// The MoE codegen here is a single-device REFERENCE implementation
// (one process, all experts on one GPU, no expert-parallel
// dispatching). It demonstrates the routing math correctly but is
// not production-grade for trillion-parameter models — those require
// torch.distributed expert-parallel + capacity bucketing not modeled
// in our codegen surface yet. Phase 1 will add a backend hook for
// distributed-MoE codegen.

import type { ComponentSpec, CodegenIR } from '../../registry/index.js';
import { nn, asInt, asString, asBool, pyBool } from './helpers.js';

const DOMAIN = 'ml';

const tensorPort = (id: string, label: string) => ({
  id,
  label,
  signature: () => ({
    shape: ['batch', 'seq', 'embed_dim'] as (string | number)[],
    dtype: 'float32' as const,
  }),
});

function activationFn(name: string): string {
  return name === 'relu' ? 'F.relu' : name === 'gelu' ? 'F.gelu' : 'F.silu';
}

// GatedFFN -------------------------------------------------------------
//
// down(act(gate(x)) * up(x)). Llama/Mistral/Mixtral conventional FFN.
// Bias defaults to False (Llama convention — gated FFNs typically omit
// bias because the element-wise multiplication folds in the offset).

const gated: ComponentSpec = {
  id: 'ml.gated_ffn',
  name: 'GatedFFN',
  category: 'ffn',
  domain: DOMAIN,
  description:
    'SwiGLU-family gated feedforward: down(act(gate(x)) * up(x)). Three linear projections. Activation choice picks the GLU variant (SwiGLU/GeGLU/ReGLU). Llama/Mistral default.',
  inputs: [tensorPort('in', 'x')],
  outputs: [tensorPort('out', 'y')],
  properties: [
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 4096,
      min: 1,
      description: 'Input/output dimensionality. Match upstream embedding.',
    },
    {
      id: 'hidden_dim',
      label: 'Hidden dim',
      kind: 'int',
      defaultValue: 11008,
      min: 1,
      description:
        'Gate/up projection size. Llama-1 convention: ~2.67 × embed_dim (rounded to multiple of 256). Llama-2 7B: 4096 → 11008.',
    },
    {
      id: 'activation',
      label: 'Activation',
      kind: 'enum',
      defaultValue: 'silu',
      choices: ['silu', 'gelu', 'relu'],
      description: 'Selects the GLU variant. silu → SwiGLU, gelu → GeGLU, relu → ReGLU.',
    },
    {
      id: 'bias',
      label: 'Bias',
      kind: 'bool',
      defaultValue: false,
      description: 'Llama convention is bias=False; classic GLU papers used bias=True.',
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.gated_ffn',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 4096);
          const hidden = asInt(props.hidden_dim, 11008);
          const bias = asBool(props.bias, false);
          const biasLit = pyBool(bias);
          return [
            `${var_}_gate = nn.Linear(${embed}, ${hidden}, bias=${biasLit})`,
            `${var_}_up = nn.Linear(${embed}, ${hidden}, bias=${biasLit})`,
            `${var_}_down = nn.Linear(${hidden}, ${embed}, bias=${biasLit})`,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) => {
          const act = activationFn(asString(props.activation, 'silu'));
          return `${outputs.out} = ${var_}_down(${act}(${var_}_gate(${inputs.in})) * ${var_}_up(${inputs.in}))`;
        },
      },
    },
  }),
};

// MoEFFN ---------------------------------------------------------------
//
// Sparse mixture of experts. Each token is routed (via top-k softmax
// of a learned router) to k of N experts. Each expert is an
// independent two-layer FFN. Outputs are combined by router weights.
//
// Defaults: 8 experts, top_k=2 (Mixtral 8x7B default). capacity_factor
// is informational here — the reference codegen below doesn't enforce
// capacity bucketing (which is essential for distributed training but
// orthogonal to demonstrating the routing math).

const moe: ComponentSpec = {
  id: 'ml.moe_ffn',
  name: 'MoEFFN',
  category: 'ffn',
  domain: DOMAIN,
  description:
    'Mixture-of-Experts feedforward. Top-k routing over N parallel expert FFNs. Mixtral/DeepSeek-MoE pattern. Reference single-device codegen; distributed expert-parallel lands in Phase 1.',
  inputs: [tensorPort('in', 'x')],
  outputs: [tensorPort('out', 'y')],
  properties: [
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 4096,
      min: 1,
    },
    // ----- routing group: "how do tokens flow to experts" -----
    {
      id: 'num_experts',
      label: 'Num experts',
      kind: 'int',
      defaultValue: 8,
      min: 2,
      group: 'routing',
      description: 'Total expert count. Mixtral: 8. DeepSeek-MoE: 64 routed + 2 shared.',
    },
    {
      id: 'top_k',
      label: 'Top-k routing',
      kind: 'int',
      defaultValue: 2,
      min: 1,
      group: 'routing',
      description: 'Experts activated per token. Mixtral: 2. Switch Transformer: 1.',
    },
    {
      id: 'capacity_factor',
      label: 'Capacity factor',
      kind: 'float',
      defaultValue: 1.25,
      min: 1.0,
      group: 'routing',
      description:
        'Per-expert token capacity multiplier (informational in this single-device codegen; distributed expert-parallel uses it for load balancing).',
    },
    // ----- expert group: "what does each expert look like" -----
    {
      id: 'hidden_dim',
      label: 'Hidden dim',
      kind: 'int',
      defaultValue: 14336,
      min: 1,
      group: 'expert',
      description: 'Per-expert FFN hidden size. Mixtral 8x7B: 14336.',
    },
    {
      id: 'activation',
      label: 'Activation',
      kind: 'enum',
      defaultValue: 'silu',
      choices: ['silu', 'gelu', 'relu'],
      group: 'expert',
    },
    {
      id: 'bias',
      label: 'Bias',
      kind: 'bool',
      defaultValue: false,
      group: 'expert',
    },
  ],
  propertyGroups: [
    {
      id: 'routing',
      label: 'Routing',
      description: 'How tokens flow to experts.',
    },
    {
      id: 'expert',
      label: 'Expert structure',
      description: 'Per-expert FFN shape and activation.',
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.moe_ffn',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 4096);
          const hidden = asInt(props.hidden_dim, 14336);
          const num = asInt(props.num_experts, 8);
          const bias = asBool(props.bias, false);
          const biasLit = pyBool(bias);
          // Each expert is a two-projection FFN (up + down). For
          // GatedFFN-style experts we'd need gate too — that's a
          // future variant (MoE-GatedFFN). For E3-3c the experts are
          // plain FFNs to keep the codegen surface manageable; the
          // gating-on-each-expert refinement lands in sub-phase F.
          return [
            `${var_}_router = nn.Linear(${embed}, ${num}, bias=False)`,
            `${var_}_experts_up = nn.ModuleList([nn.Linear(${embed}, ${hidden}, bias=${biasLit}) for _ in range(${num})])`,
            `${var_}_experts_down = nn.ModuleList([nn.Linear(${hidden}, ${embed}, bias=${biasLit}) for _ in range(${num})])`,
            `${var_}_num_experts = ${num}`,
            `${var_}_top_k = ${asInt(props.top_k, 2)}`,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) => {
          const act = activationFn(asString(props.activation, 'silu'));
          // Single-device reference: flatten tokens to [B*T, E], route,
          // dispatch via masks, combine. Not capacity-bucketed.
          return [
            `_moe_B, _moe_T, _moe_E = ${inputs.in}.shape`,
            `_moe_flat = ${inputs.in}.reshape(-1, _moe_E)  # [B*T, E]`,
            `_moe_scores = ${var_}_router(_moe_flat)  # [B*T, num_experts]`,
            `_moe_topk_w, _moe_topk_idx = _moe_scores.topk(${var_}_top_k, dim=-1)`,
            `_moe_topk_w = _moe_topk_w.softmax(dim=-1)  # normalize top-k weights`,
            `_moe_out = torch.zeros_like(_moe_flat)`,
            `for _e_i in range(${var_}_num_experts):`,
            `    _moe_mask = (_moe_topk_idx == _e_i).any(dim=-1)`,
            `    if not _moe_mask.any():`,
            `        continue`,
            `    _moe_x_e = _moe_flat[_moe_mask]`,
            `    _moe_h_e = ${act}(${var_}_experts_up[_e_i](_moe_x_e))`,
            `    _moe_y_e = ${var_}_experts_down[_e_i](_moe_h_e)`,
            `    _moe_pos = (_moe_topk_idx[_moe_mask] == _e_i).float()  # [N_e, top_k]`,
            `    _moe_w_e = (_moe_topk_w[_moe_mask] * _moe_pos).sum(dim=-1, keepdim=True)`,
            `    _moe_out[_moe_mask] += _moe_w_e * _moe_y_e`,
            `${outputs.out} = _moe_out.reshape(_moe_B, _moe_T, _moe_E)`,
          ].join('\n');
        },
      },
    },
  }),
};

export const FFN_COMPONENTS = [gated, moe] as const;
