// Activation components — Phase 0 sub-phase E, tranche E3-3b.
//
// Per ADR-0029: activations live in TWO places in the catalog by design.
//
// 1. As standalone components in the `activation` category (this file):
//    ReLU, GeLU, SiLU. Single-input single-output, shape-preserving,
//    element-wise. A user assembling a non-FFN block that needs a
//    nonlinearity drops one of these directly on the canvas.
//
// 2. As an `activation` property on FFN-family components (`ml.feedforward`
//    and the future GatedFFN/MoEFFN in E3-3c). The conventional
//    transformer FFN bakes its activation into the block, so editing
//    that property in place is the natural UX for users following a
//    standard recipe.
//
// This is INTENTIONAL OVERLAP, not redundancy: standalone activations
// support custom topologies (skip connections, gated blocks built from
// primitives, classifier heads), while inline FFN-property activations
// support the standard transformer recipe without forcing users to
// disassemble the FFN into linear + activation + linear.
//
// SwiGLU is deliberately NOT in this file. It is a gated structure
// (silu(gate(x)) * up(x)) requiring two parallel projections, not a
// pointwise activation — adding it here would violate the user's
// mental model of "activation = pointwise nonlinearity". SwiGLU lives
// as a GatedFFN variant in E3-3c (./ffn.ts).

import type { ComponentSpec, CodegenIR } from '../../registry/index.js';
import { nn } from './helpers.js';

const DOMAIN = 'ml';

// Shared input/output port shapes for all activations. They're
// shape-preserving by construction (PyTorch's element-wise functions
// don't change tensor shape), so we don't pin them to a particular
// rank — any [..., last_dim] tensor passes through unchanged.
const passthroughInput = {
  id: 'in',
  label: 'x',
  signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' as const }),
};
const passthroughOutput = {
  id: 'out',
  label: 'y',
  signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' as const }),
};

// Factory — every activation has the same shape, no properties, and a
// one-line PyTorch forward differing only in the function name. This
// keeps the per-component definition under 15 lines and makes adding
// a new activation (Mish, Tanh, etc.) a single line change.
function activationSpec(opts: {
  id: string;
  name: string;
  fnName: string;
  description: string;
}): ComponentSpec {
  return {
    id: `ml.${opts.id}`,
    name: opts.name,
    category: 'activation',
    domain: DOMAIN,
    description: opts.description,
    inputs: [passthroughInput],
    outputs: [passthroughOutput],
    properties: [],
    codegen: (props): CodegenIR => ({
      componentId: `ml.${opts.id}`,
      properties: props,
      backends: {
        pytorch: {
          imports: nn(),
          // No constructor — F.relu / F.gelu / F.silu are functional.
          // The variable assigned to `self.<name>` is unused; we keep
          // it for codegen-layer symmetry (per-node init line, even if
          // empty, lets us hold a stable name slot).
          init: () => '',
          forward: (_var, inputs, outputs) => `${outputs.out} = F.${opts.fnName}(${inputs.in})`,
        },
      },
    }),
  };
}

const relu = activationSpec({
  id: 'relu',
  name: 'ReLU',
  fnName: 'relu',
  description:
    'Rectified Linear Unit: max(0, x). Cheap, zero-gradient on negatives. Default in pre-2018 transformers (BERT-base, original Transformer).',
});

const gelu = activationSpec({
  id: 'gelu',
  name: 'GeLU',
  fnName: 'gelu',
  description:
    'Gaussian Error Linear Unit. Smoother than ReLU; standard in modern BERT-family transformers and GPT-2/3.',
});

const silu = activationSpec({
  id: 'silu',
  name: 'SiLU',
  fnName: 'silu',
  description:
    'Sigmoid Linear Unit (also called Swish): x * sigmoid(x). Used in Llama-family FFNs as the activation inside SwiGLU.',
});

export const ACTIVATION_COMPONENTS = [relu, gelu, silu] as const;
