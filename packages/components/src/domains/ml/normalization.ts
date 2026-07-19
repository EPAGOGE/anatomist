// Normalization variants — Phase 0 sub-phase E, tranche E3-3a.
//
// Catalog rationale (see ADR-0029 for the activation factoring; this
// file is the simpler sibling — no factoring choice, just one new
// component alongside the existing LayerNorm in ./index.ts):
//
// RMSNorm is the Llama-family convention: drop the mean subtraction
// and the bias, keep only the rescale by RMS(x). Faster (one reduction
// instead of two), and empirically as good or better on transformer
// stacks. Modern frontier-scale models (Llama, Mistral, Qwen, Gemma)
// use RMSNorm exclusively; BERT-era and original-Transformer recipes
// still call for LayerNorm. Both belong in the catalog under the
// `normalization` category — users browsing for "the norm" find them
// next to each other and pick by recipe.
//
// Defaults: eps=1e-6 matches the Llama codebase (smaller than the
// LayerNorm convention of 1e-5; RMSNorm is more numerically stable
// because there's no mean subtraction inflating tiny variances).
//
// PyTorch 2.4+ ships nn.RMSNorm as a first-class module. Earlier
// releases require a hand-rolled implementation; we standardize on
// the stdlib form because Phase 0 targets a current PyTorch (>=2.4).

import type { ComponentSpec, CodegenIR } from '../../registry/index.js';
import { nn, asInt, asNum } from './helpers.js';

const DOMAIN = 'ml';

// RMSNorm --------------------------------------------------------------

const rmsNorm: ComponentSpec = {
  id: 'ml.rms_norm',
  name: 'RMSNorm',
  category: 'normalization',
  domain: DOMAIN,
  description:
    'Root-mean-square normalization (Llama-family). Drops mean subtraction and bias vs LayerNorm — one reduction, no centering. nn.RMSNorm(normalized_shape, eps=...).',
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
      label: 'x_norm',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'normalized_shape',
      label: 'Normalized shape',
      kind: 'int',
      defaultValue: 768,
      min: 1,
      description: 'Size of the trailing dim being normalized. Match embed_dim.',
    },
    {
      id: 'eps',
      label: 'Epsilon',
      kind: 'float',
      defaultValue: 1e-6,
      description:
        'Numerical stability term added to the mean-square. Llama default 1e-6 (smaller than LayerNorm 1e-5 because RMSNorm has no mean subtraction).',
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.rms_norm',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const norm = asInt(props.normalized_shape, 768);
          const eps = asNum(props.eps, 1e-6);
          return `${var_} = nn.RMSNorm(${norm}, eps=${eps})`;
        },
        forward: (var_, inputs, outputs) => `${outputs.out} = ${var_}(${inputs.in})`,
      },
    },
  }),
};

export const NORMALIZATION_COMPONENTS = [rmsNorm] as const;
