// ML domain — transformer primitive set for Phase 0 sub-phase E.
//
// Six components covering the structural concerns: input, embedding,
// normalization, attention, feedforward, output. The full attention /
// position-encoding / activation / FFN catalog from the Strategic
// strategic index lands in sub-phase E2; the registry interface is shaped so
// adding a new component is a single file under this directory plus
// a register() call.
//
// Each component's `codegen` hook produces IR with a PyTorch backend
// fragment. JAX/MLX backends slot in alongside `pytorch` without
// touching the component definition.

import type {
  ComponentRegistry,
  ComponentSpec,
  CodegenIR,
  ResolvedProperties,
} from '../../registry/index.js';
import type { TensorSignature } from '../../tensor/index.js';
import {
  nn,
  asInt,
  asString,
  asBool,
  asNum,
  positionEncodingProperty,
  ropeBaseProperty,
  positionEncodingGroup,
  attentionPositionEncoding,
  type PositionEncodingChoice,
} from './helpers.js';
import { ATTENTION_COMPONENTS } from './attention.js';
import { POSITION_ENCODING_COMPONENTS } from './position-encoding.js';
import { NORMALIZATION_COMPONENTS } from './normalization.js';
import { ACTIVATION_COMPONENTS } from './activation.js';
import { FFN_COMPONENTS } from './ffn.js';
import { EMBEDDING_VARIANT_COMPONENTS } from './embedding.js';

function mhaPe(props: Record<string, unknown>): PositionEncodingChoice {
  const v = asString(props.position_encoding, 'none');
  return v === 'rope' || v === 'alibi' ? v : 'none';
}

const DOMAIN = 'ml';

// 1. Input -------------------------------------------------------------
//
// Declares the entry tensor shape. Has no inputs (it IS the input).
// The user picks shape + dtype via properties. In PyTorch this maps to
// a named argument on `forward(x)`; the codegen emits no constructor
// line, just a forward parameter binding.

const inputComponent: ComponentSpec = {
  id: 'ml.input',
  name: 'Input',
  category: 'io',
  domain: DOMAIN,
  description: 'Root of the architecture. Declares the entry tensor shape and dtype.',
  inputs: [],
  outputs: [
    {
      id: 'out',
      label: 'tensor',
      signature: (props) => buildInputSignature(props),
    },
  ],
  properties: [
    {
      id: 'shape',
      label: 'Shape',
      kind: 'string',
      defaultValue: 'batch,seq',
      description:
        'Comma-separated dims. Use names (batch, seq, embed_dim) or integers. Leftmost = outermost.',
    },
    {
      id: 'dtype',
      label: 'Dtype',
      kind: 'enum',
      defaultValue: 'int64',
      choices: ['int64', 'int32', 'float32', 'float16', 'bfloat16', 'bool'],
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.input',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: () => '',
        // Input emits no forward statement — the codegen layer publishes
        // the forward() parameter name as the `out` port's variable so
        // downstream consumers reference it directly. Returning empty
        // skips this node in the assembled forward body.
        forward: () => '',
      },
    },
  }),
};

function buildInputSignature(props: ResolvedProperties): TensorSignature {
  const raw = asString(props.shape, 'batch,seq');
  const shape = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((tok) => {
      const n = Number(tok);
      return Number.isInteger(n) && n > 0 ? n : tok;
    });
  return {
    shape,
    dtype: asString(props.dtype, 'int64') as TensorSignature['dtype'],
  };
}

// 2. Embedding ---------------------------------------------------------

// Display name is TokenEmbedding to match BERT-family vocabulary
// (alongside PositionEmbedding and SegmentEmbedding added in E3-3d).
// The id `ml.embedding` is unchanged for backwards-compat with any
// saved architectures from E1/E2.
const embeddingComponent: ComponentSpec = {
  id: 'ml.embedding',
  name: 'TokenEmbedding',
  category: 'embedding',
  domain: DOMAIN,
  description: 'Token id → dense vector lookup. nn.Embedding(vocab_size, embed_dim).',
  inputs: [
    {
      id: 'tokens',
      label: 'tokens',
      signature: () => ({ shape: ['batch', 'seq'], dtype: 'int64' }),
    },
  ],
  outputs: [
    {
      id: 'out',
      label: 'embeddings',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'vocab_size',
      label: 'Vocab size',
      kind: 'int',
      defaultValue: 50257,
      min: 1,
      description: 'Number of distinct token ids. GPT-2 default: 50257.',
    },
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 768,
      min: 1,
      description: 'Output vector dimensionality. Conventional names: 768/1024/2048.',
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.embedding',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) =>
          `${var_} = nn.Embedding(${asInt(props.vocab_size, 50257)}, ${asInt(props.embed_dim, 768)})`,
        forward: (var_, inputs, outputs) => `${outputs.out} = ${var_}(${inputs.tokens})`,
      },
    },
  }),
};

// 3. LayerNorm ---------------------------------------------------------

const layerNormComponent: ComponentSpec = {
  id: 'ml.layer_norm',
  name: 'LayerNorm',
  category: 'normalization',
  domain: DOMAIN,
  description: 'Per-sample feature normalization. nn.LayerNorm(normalized_shape).',
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
      defaultValue: 1e-5,
      description: 'Numerical stability term added to variance.',
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.layer_norm',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const norm = asInt(props.normalized_shape, 768);
          const eps = typeof props.eps === 'number' ? props.eps : 1e-5;
          return `${var_} = nn.LayerNorm(${norm}, eps=${eps})`;
        },
        forward: (var_, inputs, outputs) => `${outputs.out} = ${var_}(${inputs.in})`,
      },
    },
  }),
};

// 4. MultiHeadAttention ------------------------------------------------

const mhaComponent: ComponentSpec = {
  id: 'ml.multi_head_attention',
  name: 'MultiHeadAttention',
  category: 'attention',
  domain: DOMAIN,
  description:
    'Standard scaled-dot-product attention. nn.MultiheadAttention(embed_dim, num_heads).',
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
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 768,
      min: 1,
      description: 'Model dimensionality (must match upstream embedding).',
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
    componentId: 'ml.multi_head_attention',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          // Branch on PE: 'none' uses nn.MultiheadAttention (canonical
          // form); 'rope' / 'alibi' switch to explicit Q/K/V + SDPA so
          // the PE helper can splice in rotation / bias.
          const peChoice = mhaPe(props);
          const embed = asInt(props.embed_dim, 768);
          const heads = asInt(props.num_heads, 12);
          const dropout = asNum(props.dropout, 0.0);
          if (peChoice === 'none') {
            return `${var_} = nn.MultiheadAttention(${embed}, ${heads}, dropout=${dropout}, batch_first=True)`;
          }
          const peFrags = attentionPositionEncoding(peChoice, {
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
          const peChoice = mhaPe(props);
          if (peChoice === 'none') {
            return `${outputs.out}, _ = ${var_}(${inputs.in}, ${inputs.in}, ${inputs.in})`;
          }
          const dropout = asNum(props.dropout, 0.0);
          const peFrags = attentionPositionEncoding(peChoice, {
            varBase: var_,
            ropeBase: asNum(props.rope_base, 10000.0),
            qVar: '_q',
            kVar: '_k',
            numHeadsExpr: '_H',
          });
          const usingAlibi = peFrags.attnMaskExpr !== null;
          const sdpaArgs = usingAlibi
            ? `dropout_p=${dropout}, attn_mask=${peFrags.attnMaskExpr}`
            : `dropout_p=${dropout}`;
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

// 5. FeedForward -------------------------------------------------------

const ffComponent: ComponentSpec = {
  id: 'ml.feedforward',
  name: 'FeedForward',
  category: 'ffn',
  domain: DOMAIN,
  description: 'Two-layer position-wise feedforward with activation (GeLU default).',
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
      label: 'y',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'embed_dim',
      label: 'Embed dim',
      kind: 'int',
      defaultValue: 768,
      min: 1,
    },
    {
      id: 'hidden_dim',
      label: 'Hidden dim',
      kind: 'int',
      defaultValue: 3072,
      min: 1,
      description: 'Conventional: 4 × embed_dim.',
    },
    {
      id: 'activation',
      label: 'Activation',
      kind: 'enum',
      defaultValue: 'gelu',
      choices: ['relu', 'gelu', 'silu'],
    },
    {
      id: 'bias',
      label: 'Bias',
      kind: 'bool',
      defaultValue: true,
    },
  ],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.feedforward',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const embed = asInt(props.embed_dim, 768);
          const hidden = asInt(props.hidden_dim, 3072);
          const bias = asBool(props.bias, true);
          return [
            `${var_}_up = nn.Linear(${embed}, ${hidden}, bias=${bias ? 'True' : 'False'})`,
            `${var_}_down = nn.Linear(${hidden}, ${embed}, bias=${bias ? 'True' : 'False'})`,
          ].join('\n');
        },
        forward: (var_, inputs, outputs) => {
          const act = asString(props.activation, 'gelu');
          const actFn = act === 'relu' ? 'F.relu' : act === 'silu' ? 'F.silu' : 'F.gelu';
          return [
            `_ff = ${actFn}(${var_}_up(${inputs.in}))`,
            `${outputs.out} = ${var_}_down(_ff)`,
          ].join('\n');
        },
      },
    },
  }),
};

// 6. Output ------------------------------------------------------------
//
// Terminal node. Codegen emits a `return` statement.

const outputComponent: ComponentSpec = {
  id: 'ml.output',
  name: 'Output',
  category: 'io',
  domain: DOMAIN,
  description: 'Terminal node. The tensor flowing into Output becomes the model return value.',
  inputs: [
    {
      id: 'in',
      label: 'tensor',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  outputs: [],
  properties: [],
  codegen: (props): CodegenIR => ({
    componentId: 'ml.output',
    properties: props,
    backends: {
      pytorch: {
        imports: [],
        init: () => '',
        forward: (_var, inputs) => `return ${inputs.in}`,
      },
    },
  }),
};

// Registration ---------------------------------------------------------

/**
 * Register the ML domain primitives into a registry. Called once at
 * module load by the canvas + codegen pipelines.
 *
 * E1: six foundational primitives (Input/Embedding/LayerNorm/MHA/FF/Output).
 * E3-1: five attention variants (MQA, GQA, Flash, SlidingWindow, Cross)
 * imported from ./attention.js and registered alongside the foundation.
 */
export function loadMlDomain(registry: ComponentRegistry): void {
  registry.register(inputComponent);
  registry.register(embeddingComponent);
  registry.register(layerNormComponent);
  registry.register(mhaComponent);
  registry.register(ffComponent);
  registry.register(outputComponent);
  for (const spec of ATTENTION_COMPONENTS) registry.register(spec);
  for (const spec of POSITION_ENCODING_COMPONENTS) registry.register(spec);
  for (const spec of NORMALIZATION_COMPONENTS) registry.register(spec);
  for (const spec of ACTIVATION_COMPONENTS) registry.register(spec);
  for (const spec of FFN_COMPONENTS) registry.register(spec);
  for (const spec of EMBEDDING_VARIANT_COMPONENTS) registry.register(spec);
}

/** Exported individually for tests + the property inspector. */
export const ML_COMPONENTS = [
  inputComponent,
  embeddingComponent,
  layerNormComponent,
  mhaComponent,
  ffComponent,
  outputComponent,
  ...ATTENTION_COMPONENTS,
  ...POSITION_ENCODING_COMPONENTS,
  ...NORMALIZATION_COMPONENTS,
  ...ACTIVATION_COMPONENTS,
  ...FFN_COMPONENTS,
  ...EMBEDDING_VARIANT_COMPONENTS,
] as const;
