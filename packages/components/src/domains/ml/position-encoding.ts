// Standalone position-encoding components — Phase 0 sub-phase E, tranche E3-2.
//
// Per ADR-0028: only Absolute and Learned position encodings are
// standalone components. They add to the embedding stream and pass
// through unchanged to downstream attention. RoPE and ALiBi modify
// attention computation directly and are configured ON the attention
// variants (see helpers.ts attentionPositionEncoding).
//
// Both components are SINGLE-INPUT, SINGLE-OUTPUT, in/out shape
// [batch, seq, embed_dim] float32 — drop them between Embedding and
// the first attention layer in a typical transformer stack.

import type { ComponentSpec, CodegenIR } from '../../registry/index.js';
import { nn, asInt } from './helpers.js';

const DOMAIN = 'ml';

// AbsolutePositionEncoding ---------------------------------------------
//
// Sinusoidal positional embeddings from "Attention Is All You Need".
// Non-trainable. Computed once at module init via a register_buffer
// so it follows the module to device but isn't part of state_dict's
// learnable parameters.

const absolute: ComponentSpec = {
  id: 'ml.absolute_position_encoding',
  name: 'AbsolutePositionEncoding',
  category: 'position-encoding',
  domain: DOMAIN,
  description:
    'Sinusoidal positional embeddings from the original Transformer paper. Non-trainable register_buffer; added to the embedding stream.',
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
      label: 'x_with_pos',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'max_seq_len',
      label: 'Max sequence length',
      kind: 'int',
      defaultValue: 4096,
      min: 1,
      description: 'Precomputed PE table is sized for this many positions.',
    },
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 768,
      min: 1,
      description: 'Must equal upstream tensor last dim.',
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.absolute_position_encoding',
    properties: props,
    backends: {
      pytorch: {
        imports: [...nn(), 'import math'],
        init: (var_) => {
          const maxLen = asInt(props.max_seq_len, 4096);
          const embed = asInt(props.embed_dim, 768);
          return [
            `# Sinusoidal PE table (precomputed; not a parameter).`,
            `_pe = torch.zeros(${maxLen}, ${embed})`,
            `_pos = torch.arange(0, ${maxLen}, dtype=torch.float).unsqueeze(1)`,
            `_div_term = torch.exp(torch.arange(0, ${embed}, 2).float() * (-math.log(10000.0) / ${embed}))`,
            `_pe[:, 0::2] = torch.sin(_pos * _div_term)`,
            `_pe[:, 1::2] = torch.cos(_pos * _div_term)`,
            // register_buffer is a method on nn.Module; we set self.pe_N as
            // a buffer via a separate call after the tensor is built.
            `${var_}_pe = _pe.unsqueeze(0)  # [1, max_len, embed]`,
            `# NB: _pe captured above is a tensor, not a registered buffer.`,
            `# A wrapping nn.Module subclass should call self.register_buffer(...)`,
            `# during its own __init__ to keep _pe device-tracked.`,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) =>
          `${outputs.out} = ${inputs.in} + ${var_}_pe[:, :${inputs.in}.size(1)]`,
      },
    },
  }),
};

// Note about the absolute-PE init above: standard PyTorch practice
// computes the PE table inside __init__ then calls
// `self.register_buffer('pe', _pe)`. Our codegen layer treats each
// component's init as raw lines spliced into the parent module's
// __init__; we don't yet have an "after-init hook" for register_buffer.
// For Phase 0 sub-phase E the captured tensor on self works (it's a
// device-on-module attribute if we use `.to(device)`), with the caveat
// noted in the generated code. The cleaner register_buffer story
// lands in sub-phase F polish.

// Also need `import math` for the absolute PE constant — extend the
// imports below.

// LearnedPositionEncoding ----------------------------------------------
//
// Trainable position embeddings via nn.Embedding indexed by position.
// BERT-family pattern. Output: x + pos_embed(positions).

const learned: ComponentSpec = {
  id: 'ml.learned_position_encoding',
  name: 'LearnedPositionEncoding',
  category: 'position-encoding',
  domain: DOMAIN,
  description:
    'Trainable position embeddings via nn.Embedding(max_seq_len, embed_dim). BERT-family pattern. Added to the embedding stream.',
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
      label: 'x_with_pos',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'max_seq_len',
      label: 'Max sequence length',
      kind: 'int',
      defaultValue: 4096,
      min: 1,
    },
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 768,
      min: 1,
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.learned_position_encoding',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const maxLen = asInt(props.max_seq_len, 4096);
          const embed = asInt(props.embed_dim, 768);
          return `${var_} = nn.Embedding(${maxLen}, ${embed})`;
        },
        forward: (var_, inputs, outputs) => {
          // Positions: torch.arange(seq_len) broadcast to [1, seq, embed].
          return [
            `_pos_ids = torch.arange(${inputs.in}.size(1), device=${inputs.in}.device)`,
            `${outputs.out} = ${inputs.in} + ${var_}(_pos_ids).unsqueeze(0)`,
          ].join('\n');
        },
      },
    },
  }),
};

export const POSITION_ENCODING_COMPONENTS = [absolute, learned] as const;
