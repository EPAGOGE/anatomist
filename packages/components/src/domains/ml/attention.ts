// Attention variants — Phase 0 sub-phase E, tranche E3-1.
//
// Five new attention components alongside the existing MultiHeadAttention
// from E1:
//   - MultiQueryAttention (MQA): single shared K/V across heads
//   - GroupedQueryAttention (GQA): variable num_kv_heads (1 < kv < heads)
//   - FlashAttention: SDPA backend, equivalent math to MHA
//   - SlidingWindowAttention: attention restricted to a local window
//   - CrossAttention: separate Query vs Key/Value inputs (two ports)
//
// Codegen strategy:
//   - MQA, GQA, Flash, SlidingWindow: explicit Q/K/V Linear projections
//     plus F.scaled_dot_product_attention. SDPA dispatches to FlashAttention
//     on CUDA when supported, so "Flash" is really "explicitly request the
//     SDPA path." MQA/GQA differ in projection shapes; SlidingWindow uses
//     a causal mask shaped to the window size.
//   - CrossAttention: nn.MultiheadAttention(batch_first=True) called with
//     separate q and shared kv. Cleanest available standard idiom.
//
// All five emit working PyTorch. None pull in custom CUDA kernels — they
// stay in the standard ATen / F.scaled_dot_product_attention surface so
// generated code runs on CPU and CUDA without extra deps. Users wanting
// hand-tuned kernels can swap in their own implementations on top of the
// generated code; the canvas captures the architectural intent.
//
// Port signature convention:
//   single-input attention (MQA, GQA, Flash, SlidingWindow):
//     in:  Tensor[batch, seq, embed_dim]:float32
//     out: Tensor[batch, seq, embed_dim]:float32
//   cross-attention:
//     query:     Tensor[batch, seq_q, embed_dim]:float32
//     key_value: Tensor[batch, seq_kv, embed_dim]:float32
//     out:       Tensor[batch, seq_q, embed_dim]:float32

import type { ComponentSpec, CodegenIR } from '../../registry/index.js';
import {
  nn,
  asInt,
  asNum,
  asString,
  pyBool,
  positionEncodingProperty,
  ropeBaseProperty,
  positionEncodingGroup,
  attentionPositionEncoding,
  type PositionEncodingChoice,
} from './helpers.js';

const DOMAIN = 'ml';

/** Narrow PositionEncodingChoice from raw property string. */
function pe(props: Record<string, unknown>): PositionEncodingChoice {
  const v = asString(props.position_encoding, 'none');
  return v === 'rope' || v === 'alibi' ? v : 'none';
}

// MultiQueryAttention --------------------------------------------------
//
// All heads share a single K and V projection. Drastically reduces KV
// cache size (relevant for inference) without much quality cost on
// sufficient scale. Implemented via explicit Linear projections + SDPA.

const mqa: ComponentSpec = {
  id: 'ml.multi_query_attention',
  name: 'MultiQueryAttention',
  category: 'attention',
  domain: DOMAIN,
  description:
    'Multi-query attention: all heads share one K and V projection (PaLM-style). Cuts KV cache size; minor quality trade-off at scale.',
  inputs: [
    {
      id: 'in',
      label: 'x',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  outputs: [
    {
      id: 'out',
      label: 'attn',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'num_heads',
      label: 'Heads',
      kind: 'int',
      defaultValue: 12,
      min: 1,
      divides: 'embed_dim',
      description: 'Number of query heads. embed_dim must be divisible by num_heads.',
    },
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 768,
      min: 1,
      description: 'Model dimensionality. Must equal upstream tensor last dim.',
    },
    {
      id: 'dropout',
      label: 'Dropout',
      kind: 'float',
      defaultValue: 0.0,
      min: 0,
      max: 1,
    },
    {
      id: 'is_causal',
      label: 'Causal mask',
      kind: 'bool',
      defaultValue: false,
      description: 'Apply autoregressive (lower-triangular) attention mask.',
    },
    positionEncodingProperty(),
    ropeBaseProperty(),
  ],
  propertyGroups: [positionEncodingGroup()],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.multi_query_attention',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 768);
          const heads = asInt(props.num_heads, 12);
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          return [
            `${var_}_q = nn.Linear(${embed}, ${embed})`,
            `${var_}_k = nn.Linear(${embed}, ${embed} // ${heads})`,
            `${var_}_v = nn.Linear(${embed}, ${embed} // ${heads})`,
            `${var_}_proj = nn.Linear(${embed}, ${embed})`,
            `${var_}_num_heads = ${heads}`,
            ...peFrags.initLines,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) => {
          const dropout = asNum(props.dropout, 0.0);
          const isCausal = props.is_causal === true;
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          // ALiBi supplies a float attn_mask. SDPA accepts it directly;
          // combining with is_causal is delegated to the user (the
          // boolean is_causal flag and a float attn_mask are not
          // jointly composable in one SDPA call). When ALiBi is set,
          // is_causal is dropped from the SDPA call.
          const usingAlibi = peFrags.attnMaskExpr !== null;
          const sdpaArgs = usingAlibi
            ? `dropout_p=${dropout}, attn_mask=${peFrags.attnMaskExpr}`
            : `dropout_p=${dropout}, is_causal=${pyBool(isCausal)}`;
          return [
            `_q = ${var_}_q(${inputs.in})`,
            `_k = ${var_}_k(${inputs.in}).unsqueeze(1)  # [B, 1, T, head_dim]`,
            `_v = ${var_}_v(${inputs.in}).unsqueeze(1)`,
            `_B, _T, _E = _q.shape`,
            `_H = ${var_}_num_heads`,
            `_q = _q.view(_B, _T, _H, _E // _H).transpose(1, 2)  # [B, H, T, head_dim]`,
            `_k = _k.expand(_B, _H, _T, _E // _H)`,
            `_v = _v.expand(_B, _H, _T, _E // _H)`,
            ...peFrags.preAttnLines,
            `_attn = F.scaled_dot_product_attention(_q, _k, _v, ${sdpaArgs})`,
            `${outputs.out} = ${var_}_proj(_attn.transpose(1, 2).contiguous().view(_B, _T, _E))`,
          ].join('\n');
        },
      },
    },
  }),
};

// GroupedQueryAttention ------------------------------------------------
//
// Between MHA (num_kv_heads == num_heads) and MQA (num_kv_heads == 1).
// Llama-family default. Each group of (num_heads / num_kv_heads) query
// heads shares one K/V head.

const gqa: ComponentSpec = {
  id: 'ml.grouped_query_attention',
  name: 'GroupedQueryAttention',
  category: 'attention',
  domain: DOMAIN,
  description:
    'Grouped-query attention (GQA): num_kv_heads between 1 and num_heads. Llama-family default. Balances MHA quality with MQA efficiency.',
  inputs: [
    {
      id: 'in',
      label: 'x',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  outputs: [
    {
      id: 'out',
      label: 'attn',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'num_heads',
      label: 'Query heads',
      kind: 'int',
      defaultValue: 12,
      min: 1,
      divides: 'embed_dim',
      description: 'Number of query heads. embed_dim must be divisible by num_heads.',
    },
    {
      id: 'num_kv_heads',
      label: 'KV heads',
      kind: 'int',
      defaultValue: 4,
      min: 1,
      divides: 'num_heads',
      description:
        'Number of key/value heads. num_heads must be divisible by num_kv_heads. 1 = MQA, num_heads = MHA.',
    },
    { id: 'embed_dim', label: 'Embed dim', kind: 'int', defaultValue: 768, min: 1 },
    {
      id: 'dropout',
      label: 'Dropout',
      kind: 'float',
      defaultValue: 0.0,
      min: 0,
      max: 1,
    },
    { id: 'is_causal', label: 'Causal mask', kind: 'bool', defaultValue: false },
    positionEncodingProperty(),
    ropeBaseProperty(),
  ],
  propertyGroups: [positionEncodingGroup()],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.grouped_query_attention',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 768);
          const heads = asInt(props.num_heads, 12);
          const kvHeads = asInt(props.num_kv_heads, 4);
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          return [
            `${var_}_q = nn.Linear(${embed}, ${embed})`,
            `${var_}_k = nn.Linear(${embed}, ${kvHeads} * (${embed} // ${heads}))`,
            `${var_}_v = nn.Linear(${embed}, ${kvHeads} * (${embed} // ${heads}))`,
            `${var_}_proj = nn.Linear(${embed}, ${embed})`,
            `${var_}_num_heads = ${heads}`,
            `${var_}_num_kv_heads = ${kvHeads}`,
            ...peFrags.initLines,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) => {
          const dropout = asNum(props.dropout, 0.0);
          const isCausal = props.is_causal === true;
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          const usingAlibi = peFrags.attnMaskExpr !== null;
          const sdpaArgs = usingAlibi
            ? `dropout_p=${dropout}, attn_mask=${peFrags.attnMaskExpr}`
            : `dropout_p=${dropout}, is_causal=${pyBool(isCausal)}`;
          return [
            `_q = ${var_}_q(${inputs.in})`,
            `_k = ${var_}_k(${inputs.in})`,
            `_v = ${var_}_v(${inputs.in})`,
            `_B, _T, _E = _q.shape`,
            `_H = ${var_}_num_heads`,
            `_Hkv = ${var_}_num_kv_heads`,
            `_head_dim = _E // _H`,
            `_q = _q.view(_B, _T, _H, _head_dim).transpose(1, 2)`,
            `_k = _k.view(_B, _T, _Hkv, _head_dim).transpose(1, 2)`,
            `_v = _v.view(_B, _T, _Hkv, _head_dim).transpose(1, 2)`,
            `# Repeat KV heads to match Q head count (broadcast over groups).`,
            `_repeat = _H // _Hkv`,
            `_k = _k.repeat_interleave(_repeat, dim=1)`,
            `_v = _v.repeat_interleave(_repeat, dim=1)`,
            ...peFrags.preAttnLines,
            `_attn = F.scaled_dot_product_attention(_q, _k, _v, ${sdpaArgs})`,
            `${outputs.out} = ${var_}_proj(_attn.transpose(1, 2).contiguous().view(_B, _T, _E))`,
          ].join('\n');
        },
      },
    },
  }),
};

// FlashAttention --------------------------------------------------------
//
// Mathematically equivalent to MHA. F.scaled_dot_product_attention
// auto-dispatches to FlashAttention kernels on CUDA when shapes + dtypes
// permit, so the canvas distinction is "the user wanted to request the
// SDPA path explicitly." Generated code uses SDPA + explicit Q/K/V
// projections (rather than nn.MultiheadAttention which can hide kernel
// dispatch behind its own logic).

const flash: ComponentSpec = {
  id: 'ml.flash_attention',
  name: 'FlashAttention',
  category: 'attention',
  domain: DOMAIN,
  description:
    'Standard attention using F.scaled_dot_product_attention. SDPA dispatches to FlashAttention on CUDA when supported. Mathematically equivalent to MHA; faster + lower memory.',
  inputs: [
    {
      id: 'in',
      label: 'x',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  outputs: [
    {
      id: 'out',
      label: 'attn',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'num_heads',
      label: 'Heads',
      kind: 'int',
      defaultValue: 12,
      min: 1,
      divides: 'embed_dim',
      description: 'Number of attention heads. embed_dim must be divisible by num_heads.',
    },
    { id: 'embed_dim', label: 'Embed dim', kind: 'int', defaultValue: 768, min: 1 },
    {
      id: 'dropout',
      label: 'Dropout',
      kind: 'float',
      defaultValue: 0.0,
      min: 0,
      max: 1,
    },
    { id: 'is_causal', label: 'Causal mask', kind: 'bool', defaultValue: true },
    positionEncodingProperty(),
    ropeBaseProperty(),
  ],
  propertyGroups: [positionEncodingGroup()],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.flash_attention',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 768);
          const heads = asInt(props.num_heads, 12);
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          return [
            `${var_}_qkv = nn.Linear(${embed}, 3 * ${embed})`,
            `${var_}_proj = nn.Linear(${embed}, ${embed})`,
            `${var_}_num_heads = ${heads}`,
            ...peFrags.initLines,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) => {
          const dropout = asNum(props.dropout, 0.0);
          const isCausal = props.is_causal !== false;
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          const usingAlibi = peFrags.attnMaskExpr !== null;
          const sdpaArgs = usingAlibi
            ? `dropout_p=${dropout}, attn_mask=${peFrags.attnMaskExpr}`
            : `dropout_p=${dropout}, is_causal=${pyBool(isCausal)}`;
          return [
            `_qkv = ${var_}_qkv(${inputs.in})`,
            `_B, _T, _ = _qkv.shape`,
            `_H = ${var_}_num_heads`,
            `_E = _qkv.size(-1) // 3`,
            `_q, _k, _v = _qkv.split(_E, dim=-1)`,
            `_q = _q.view(_B, _T, _H, _E // _H).transpose(1, 2)`,
            `_k = _k.view(_B, _T, _H, _E // _H).transpose(1, 2)`,
            `_v = _v.view(_B, _T, _H, _E // _H).transpose(1, 2)`,
            ...peFrags.preAttnLines,
            `_attn = F.scaled_dot_product_attention(_q, _k, _v, ${sdpaArgs})`,
            `${outputs.out} = ${var_}_proj(_attn.transpose(1, 2).contiguous().view(_B, _T, _E))`,
          ].join('\n');
        },
      },
    },
  }),
};

// SlidingWindowAttention -----------------------------------------------
//
// Attention restricted to a local window (Mistral-style). Each query
// attends only to the most recent `window_size` keys. Implemented by
// constructing a banded boolean mask and passing as attn_mask to SDPA.

const sliding: ComponentSpec = {
  id: 'ml.sliding_window_attention',
  name: 'SlidingWindowAttention',
  category: 'attention',
  domain: DOMAIN,
  description:
    'Attention restricted to a local window (Mistral-style). Each query attends only to the previous `window_size` keys.',
  inputs: [
    {
      id: 'in',
      label: 'x',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  outputs: [
    {
      id: 'out',
      label: 'attn',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'num_heads',
      label: 'Heads',
      kind: 'int',
      defaultValue: 12,
      min: 1,
      divides: 'embed_dim',
      description: 'Number of attention heads. embed_dim must be divisible by num_heads.',
    },
    { id: 'embed_dim', label: 'Embed dim', kind: 'int', defaultValue: 768, min: 1 },
    {
      id: 'window_size',
      label: 'Window size',
      kind: 'int',
      defaultValue: 4096,
      min: 1,
      description: 'Each query attends to the previous N keys (and itself).',
    },
    {
      id: 'dropout',
      label: 'Dropout',
      kind: 'float',
      defaultValue: 0.0,
      min: 0,
      max: 1,
    },
    positionEncodingProperty(),
    ropeBaseProperty(),
  ],
  propertyGroups: [positionEncodingGroup()],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.sliding_window_attention',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 768);
          const heads = asInt(props.num_heads, 12);
          const window = asInt(props.window_size, 4096);
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          return [
            `${var_}_qkv = nn.Linear(${embed}, 3 * ${embed})`,
            `${var_}_proj = nn.Linear(${embed}, ${embed})`,
            `${var_}_num_heads = ${heads}`,
            `${var_}_window = ${window}`,
            ...peFrags.initLines,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) => {
          const dropout = asNum(props.dropout, 0.0);
          const peFrags = attentionPositionEncoding(pe(props), {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          // SlidingWindow always uses a window mask. When ALiBi is on,
          // combine: convert the boolean window mask to -inf-or-0 float
          // and add the ALiBi bias. The resulting float mask is what
          // SDPA gets.
          const usingAlibi = peFrags.attnMaskExpr !== null;
          const finalMaskBuild = usingAlibi
            ? [
                `# Combine boolean window mask with float ALiBi bias.`,
                `_window_float = torch.where(_window_mask, 0.0, float('-inf'))`,
                `_final_mask = _window_float + ${peFrags.attnMaskExpr}`,
              ]
            : [];
          const sdpaMask = usingAlibi ? '_final_mask' : '_window_mask';
          return [
            `_qkv = ${var_}_qkv(${inputs.in})`,
            `_B, _T, _ = _qkv.shape`,
            `_H = ${var_}_num_heads`,
            `_W = ${var_}_window`,
            `_E = _qkv.size(-1) // 3`,
            `_q, _k, _v = _qkv.split(_E, dim=-1)`,
            `_q = _q.view(_B, _T, _H, _E // _H).transpose(1, 2)`,
            `_k = _k.view(_B, _T, _H, _E // _H).transpose(1, 2)`,
            `_v = _v.view(_B, _T, _H, _E // _H).transpose(1, 2)`,
            ...peFrags.preAttnLines,
            `# Sliding-window causal mask: q_i can attend to k_j when 0 <= i - j < W.`,
            `_idx = torch.arange(_T, device=_q.device)`,
            `_window_mask = (_idx.unsqueeze(0) - _idx.unsqueeze(1) >= 0) & (_idx.unsqueeze(0) - _idx.unsqueeze(1) < _W)`,
            `_window_mask = _window_mask.unsqueeze(0).unsqueeze(0)  # [1, 1, T, T]`,
            ...finalMaskBuild,
            `_attn = F.scaled_dot_product_attention(_q, _k, _v, attn_mask=${sdpaMask}, dropout_p=${dropout})`,
            `${outputs.out} = ${var_}_proj(_attn.transpose(1, 2).contiguous().view(_B, _T, _E))`,
          ].join('\n');
        },
      },
    },
  }),
};

// CrossAttention -------------------------------------------------------
//
// Query from one stream, K/V from another. Encoder-decoder, multimodal,
// retrieval-augmented patterns. TWO input ports (multi-input — proves
// the canvas's multi-input plumbing from E2-5).

const cross: ComponentSpec = {
  id: 'ml.cross_attention',
  name: 'CrossAttention',
  category: 'attention',
  domain: DOMAIN,
  description:
    'Attention where Query and Key/Value come from different streams. Encoder-decoder, multimodal, retrieval-augmented architectures.',
  inputs: [
    {
      id: 'query',
      label: 'q',
      signature: () => ({ shape: ['batch', 'seq_q', 'embed_dim'], dtype: 'float32' }),
    },
    {
      id: 'key_value',
      label: 'kv',
      signature: () => ({ shape: ['batch', 'seq_kv', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  outputs: [
    {
      id: 'out',
      label: 'attn',
      signature: () => ({ shape: ['batch', 'seq_q', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'num_heads',
      label: 'Heads',
      kind: 'int',
      defaultValue: 12,
      min: 1,
      divides: 'embed_dim',
      description: 'Number of attention heads. embed_dim must be divisible by num_heads.',
    },
    { id: 'embed_dim', label: 'Embed dim', kind: 'int', defaultValue: 768, min: 1 },
    {
      id: 'dropout',
      label: 'Dropout',
      kind: 'float',
      defaultValue: 0.0,
      min: 0,
      max: 1,
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.cross_attention',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 768);
          const heads = asInt(props.num_heads, 12);
          const dropout = asNum(props.dropout, 0.0);
          return `${var_} = nn.MultiheadAttention(${embed}, ${heads}, dropout=${dropout}, batch_first=True)`;
        },
        forward: (var_, inputs, outputs) =>
          // q from inputs.query; k=v from inputs.key_value
          `${outputs.out}, _ = ${var_}(${inputs.query}, ${inputs.key_value}, ${inputs.key_value})`,
      },
    },
  }),
};

export const ATTENTION_COMPONENTS = [mqa, gqa, flash, sliding, cross] as const;
