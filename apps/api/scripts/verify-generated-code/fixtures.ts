// Representative architecture fixtures for F-0 Criterion 3 verification.
//
// Four architectures chosen to exercise the structural concerns of the
// codegen pipeline:
//
//   1. gqa-decoder-block: GQA + RoPE + RMSNorm + GatedFFN — exercises
//      the most-adjusted attention variant with its position-encoding
//      branch, the Llama-family normalization, and the gated FFN.
//
//   2. moe-ffn-block: Input + MoEFFN + Output — exercises the most
//      structurally complex codegen (router, expert ModuleList,
//      top-k dispatch, per-expert forward, weighted recombination).
//
//   3. cross-attention-encdec: two Inputs feeding into CrossAttention —
//      exercises the multi-input plumbing (E2-5) and the two-stream
//      attention path.
//
//   4. full-small-transformer: an integrated stack composing several
//      component types together. Per the F-0 brief, this catches
//      shape-threading bugs that individual-component tests miss.
//      Input → TokenEmbedding → AbsolutePositionEncoding → LayerNorm →
//      MultiHeadAttention → FeedForward → LayerNorm → Output.

import type { GraphSpec } from '@epagoge/codegen';

export const VERIFICATION_FIXTURES: ReadonlyArray<{
  readonly id: string;
  readonly description: string;
  readonly graph: GraphSpec;
  /**
   * Forward-pass test setup: how to construct the dummy input tensor(s)
   * and what output shape to expect. Used by the python runner.
   */
  readonly forwardTest: {
    readonly inputs: ReadonlyArray<{
      readonly param: string;
      readonly shape: readonly number[];
      readonly dtype: 'long' | 'float';
    }>;
    readonly expectedOutputShape: readonly number[];
    /** When the model returns a tuple, which element to check (default: 0). */
    readonly outputIndex?: number;
  };
}> = [
  // -------------------------------------------------------------------
  // 1. GQA decoder block: GQA + RoPE + RMSNorm + GatedFFN.
  // -------------------------------------------------------------------
  {
    id: 'gqa-decoder-block',
    description:
      'Llama-style decoder block: Input -> RMSNorm -> GQA (RoPE) -> GatedFFN (SwiGLU) -> Output.',
    graph: {
      version: 1,
      name: 'GqaDecoderBlock',
      nodes: [
        {
          id: 'in',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'rms',
          componentId: 'ml.rms_norm',
          properties: { normalized_shape: 512, eps: 1e-6 },
        },
        {
          id: 'gqa',
          componentId: 'ml.grouped_query_attention',
          properties: {
            embed_dim: 512,
            num_heads: 8,
            num_kv_heads: 4,
            dropout: 0.0,
            is_causal: true,
            position_encoding: 'rope',
            rope_base: 10000.0,
          },
        },
        {
          id: 'ffn',
          componentId: 'ml.gated_ffn',
          properties: {
            embed_dim: 512,
            hidden_dim: 1024,
            activation: 'silu',
            bias: false,
          },
        },
        { id: 'out', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portId: 'out' },
          target: { nodeId: 'rms', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'rms', portId: 'out' },
          target: { nodeId: 'gqa', portId: 'in' },
        },
        {
          id: 'e3',
          source: { nodeId: 'gqa', portId: 'out' },
          target: { nodeId: 'ffn', portId: 'in' },
        },
        {
          id: 'e4',
          source: { nodeId: 'ffn', portId: 'out' },
          target: { nodeId: 'out', portId: 'in' },
        },
      ],
    },
    forwardTest: {
      inputs: [{ param: 'x', shape: [2, 16, 512], dtype: 'float' }],
      expectedOutputShape: [2, 16, 512],
    },
  },

  // -------------------------------------------------------------------
  // 2. MoE FFN block.
  // -------------------------------------------------------------------
  {
    id: 'moe-ffn-block',
    description: 'MoEFFN with Mixtral-style routing (8 experts, top-2). Smallest sizes for speed.',
    graph: {
      version: 1,
      name: 'MoeFfnBlock',
      nodes: [
        {
          id: 'in',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'moe',
          componentId: 'ml.moe_ffn',
          properties: {
            embed_dim: 64,
            hidden_dim: 128,
            num_experts: 4,
            top_k: 2,
            capacity_factor: 1.25,
            activation: 'silu',
            bias: false,
          },
        },
        { id: 'out', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portId: 'out' },
          target: { nodeId: 'moe', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'moe', portId: 'out' },
          target: { nodeId: 'out', portId: 'in' },
        },
      ],
    },
    forwardTest: {
      inputs: [{ param: 'x', shape: [2, 8, 64], dtype: 'float' }],
      expectedOutputShape: [2, 8, 64],
    },
  },

  // -------------------------------------------------------------------
  // 3. CrossAttention encoder/decoder (multi-input plumbing).
  // -------------------------------------------------------------------
  {
    id: 'cross-attention-encdec',
    description:
      'Two-input cross-attention: separate query and key/value streams feed CrossAttention.',
    graph: {
      version: 1,
      name: 'CrossAttentionEncDec',
      nodes: [
        {
          id: 'in_q',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq_q,embed_dim', dtype: 'float32' },
        },
        {
          id: 'in_kv',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq_kv,embed_dim', dtype: 'float32' },
        },
        {
          id: 'xattn',
          componentId: 'ml.cross_attention',
          properties: { embed_dim: 128, num_heads: 8, dropout: 0.0 },
        },
        { id: 'out', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_q', portId: 'out' },
          target: { nodeId: 'xattn', portId: 'query' },
        },
        {
          id: 'e2',
          source: { nodeId: 'in_kv', portId: 'out' },
          target: { nodeId: 'xattn', portId: 'key_value' },
        },
        {
          id: 'e3',
          source: { nodeId: 'xattn', portId: 'out' },
          target: { nodeId: 'out', portId: 'in' },
        },
      ],
    },
    forwardTest: {
      // NOTE: multi-input forward-parameter ordering is alphabetical
      // by node id (the codegen's topological tie-break), NOT
      // declaration order. With node ids "in_kv" and "in_q", `x0`
      // receives the in_kv tensor and `x1` receives the in_q tensor.
      // First torch run of this harness (2026-05-20) surfaced this:
      // the prior fixture had x0=[2,10,128]/q, x1=[2,14,128]/kv and
      // failed because the codegen swapped them. The fixture below
      // matches the actual generated `forward(self, x0, x1)` shape.
      // The UX implication — users can't predict which arg position
      // their query vs kv stream lands in without reading generated
      // code — is a Phase 1 ergonomics item (forward param docstring
      // or named params per Input node).
      inputs: [
        { param: 'x0', shape: [2, 14, 128], dtype: 'float' }, // in_kv stream
        { param: 'x1', shape: [2, 10, 128], dtype: 'float' }, // in_q stream
      ],
      expectedOutputShape: [2, 10, 128], // CrossAttention output follows query seq length
    },
  },

  // -------------------------------------------------------------------
  // 4. Full small transformer — composition test.
  //    Catches shape-threading bugs that individual-component tests
  //    miss. Per the F-0 brief: component integration is where
  //    integration-only bugs hide.
  // -------------------------------------------------------------------
  {
    id: 'full-small-transformer',
    description:
      'Integrated stack: Input(tokens) -> TokenEmbedding -> AbsolutePE -> LayerNorm -> MHA -> LayerNorm -> FeedForward -> LayerNorm -> Output. Composition stress test.',
    graph: {
      version: 1,
      name: 'FullSmallTransformer',
      nodes: [
        { id: 'in', componentId: 'ml.input', properties: { shape: 'batch,seq', dtype: 'int64' } },
        {
          id: 'tok',
          componentId: 'ml.embedding',
          properties: { vocab_size: 256, embed_dim: 64 },
        },
        {
          id: 'pos',
          componentId: 'ml.absolute_position_encoding',
          properties: { max_seq_len: 64, embed_dim: 64 },
        },
        {
          id: 'norm1',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 64, eps: 1e-5 },
        },
        {
          id: 'mha',
          componentId: 'ml.multi_head_attention',
          properties: { embed_dim: 64, num_heads: 8, dropout: 0.0 },
        },
        {
          id: 'norm2',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 64, eps: 1e-5 },
        },
        {
          id: 'ff',
          componentId: 'ml.feedforward',
          properties: { embed_dim: 64, hidden_dim: 128, activation: 'gelu', bias: true },
        },
        {
          id: 'norm3',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 64, eps: 1e-5 },
        },
        { id: 'out', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portId: 'out' },
          target: { nodeId: 'tok', portId: 'tokens' },
        },
        {
          id: 'e2',
          source: { nodeId: 'tok', portId: 'out' },
          target: { nodeId: 'pos', portId: 'in' },
        },
        {
          id: 'e3',
          source: { nodeId: 'pos', portId: 'out' },
          target: { nodeId: 'norm1', portId: 'in' },
        },
        {
          id: 'e4',
          source: { nodeId: 'norm1', portId: 'out' },
          target: { nodeId: 'mha', portId: 'in' },
        },
        {
          id: 'e5',
          source: { nodeId: 'mha', portId: 'out' },
          target: { nodeId: 'norm2', portId: 'in' },
        },
        {
          id: 'e6',
          source: { nodeId: 'norm2', portId: 'out' },
          target: { nodeId: 'ff', portId: 'in' },
        },
        {
          id: 'e7',
          source: { nodeId: 'ff', portId: 'out' },
          target: { nodeId: 'norm3', portId: 'in' },
        },
        {
          id: 'e8',
          source: { nodeId: 'norm3', portId: 'out' },
          target: { nodeId: 'out', portId: 'in' },
        },
      ],
    },
    forwardTest: {
      inputs: [{ param: 'x', shape: [2, 16], dtype: 'long' }],
      expectedOutputShape: [2, 16, 64],
    },
  },
];
