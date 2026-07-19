// Embedding variants — Phase 0 sub-phase E, tranche E3-3d.
//
// Per ADR-0030: the embedding category gets BERT-family multi-stream
// inputs (Token + Position + Segment). The existing component named
// "TokenEmbedding" (id `ml.embedding`, see ../index.ts) is the
// canonical token lookup; this file adds the position and segment
// streams.
//
// INTENTIONAL OVERLAP with LearnedPositionEncoding (./position-encoding.ts):
// PositionEmbedding here is mechanically identical to LearnedPositionEncoding
// — both are nn.Embedding(max_seq_len, embed_dim) indexed by position
// and added to the running stream — but they live in different
// categories because users with different mental models look for
// them in different places:
//
//   - A user thinking "I'm assembling BERT" looks in the embedding
//     category for TokenEmbedding, PositionEmbedding, SegmentEmbedding.
//     Position is "another embedding stream", conceptually grouped
//     with the others.
//
//   - A user thinking "I'm choosing how positions flow into my
//     attention layers" looks in the position-encoding category
//     and weighs Absolute vs Learned vs RoPE-on-attention vs ALiBi.
//     Position is "a positional encoding strategy".
//
// Both mental models are legitimate. The cost of having two
// components is small (one file, one extra entry in the palette);
// the cost of forcing every user through one mental model is high
// (BERT-era users get confused when "position embedding" is missing
// from the embedding category, and Llama-era users get confused
// when LearnedPositionEncoding is split off from a "PositionEmbedding"
// they already know).
//
// SegmentEmbedding is BERT-specific: a small (typically 2-entry)
// embedding indexed by segment id (0 = sentence A, 1 = sentence B).
// Used in BERT's Next Sentence Prediction objective and inherited
// by RoBERTa/DistilBERT/etc. Modern decoder-only models don't use it.

import type { ComponentSpec, CodegenIR } from '../../registry/index.js';
import { nn, asInt } from './helpers.js';

const DOMAIN = 'ml';

// PositionEmbedding ----------------------------------------------------
//
// Trainable position embedding added to the running stream. Mechanically
// equivalent to LearnedPositionEncoding (./position-encoding.ts); see
// ADR-0030 for the rationale on having both.

const positionEmbedding: ComponentSpec = {
  id: 'ml.position_embedding',
  name: 'PositionEmbedding',
  category: 'embedding',
  domain: DOMAIN,
  description:
    'Trainable position embeddings indexed by position id, added to the running stream. BERT-family convention. Mechanically equivalent to LearnedPositionEncoding (position-encoding category); listed here for users with a BERT-style mental model.',
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
      defaultValue: 512,
      min: 1,
      description: 'BERT-base default: 512. RoBERTa: 514 (positions 0 and 1 reserved).',
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
    componentId: 'ml.position_embedding',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const maxLen = asInt(props.max_seq_len, 512);
          const embed = asInt(props.embed_dim, 768);
          return `${var_} = nn.Embedding(${maxLen}, ${embed})`;
        },
        forward: (var_, inputs, outputs) =>
          [
            `_pos_ids = torch.arange(${inputs.in}.size(1), device=${inputs.in}.device)`,
            `${outputs.out} = ${inputs.in} + ${var_}(_pos_ids).unsqueeze(0)`,
          ].join('\n'),
      },
    },
  }),
};

// SegmentEmbedding -----------------------------------------------------
//
// Indexed by segment id. BERT NSP objective uses two segments
// (sentence A vs sentence B). The component takes the running stream
// PLUS a segment_ids tensor [batch, seq] of int64 and adds the
// segment embedding to the stream.

const segmentEmbedding: ComponentSpec = {
  id: 'ml.segment_embedding',
  name: 'SegmentEmbedding',
  category: 'embedding',
  domain: DOMAIN,
  description:
    'Per-segment embedding added to the running stream. BERT-family NSP objective; segment_ids [B, T] selects between (typically) two segment vectors.',
  inputs: [
    {
      id: 'in',
      label: 'x',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
    {
      id: 'segment_ids',
      label: 'segment_ids',
      signature: () => ({ shape: ['batch', 'seq'], dtype: 'int64' }),
    },
  ],
  outputs: [
    {
      id: 'out',
      label: 'x_with_seg',
      signature: () => ({ shape: ['batch', 'seq', 'embed_dim'], dtype: 'float32' }),
    },
  ],
  properties: [
    {
      id: 'num_segments',
      label: 'Num segments',
      kind: 'int',
      defaultValue: 2,
      min: 1,
      description: 'BERT default: 2 (sentence A, sentence B). RoBERTa drops NSP; uses 1.',
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
    componentId: 'ml.segment_embedding',
    properties: props,
    backends: {
      pytorch: {
        imports: nn(),
        init: (var_) => {
          const num = asInt(props.num_segments, 2);
          const embed = asInt(props.embed_dim, 768);
          return `${var_} = nn.Embedding(${num}, ${embed})`;
        },
        forward: (var_, inputs, outputs) =>
          `${outputs.out} = ${inputs.in} + ${var_}(${inputs.segment_ids})`,
      },
    },
  }),
};

export const EMBEDDING_VARIANT_COMPONENTS = [positionEmbedding, segmentEmbedding] as const;
