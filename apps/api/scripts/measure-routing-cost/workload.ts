// Representative query workload for F-0 Criterion 6.
//
// Per the F-0 brief, the workload must SPAN the routing tiers — some
// queries the router sends to Haiku, some to Sonnet, some to Opus —
// so the measured cost efficiency reflects real routing behavior
// rather than a cherry-picked set that all routes cheaply. Including
// cases where routing doesn't help (i.e. the router selects Opus
// anyway) is the honest version.
//
// Categories represented:
//   - Simple factual / classification (short, isSimple=true)        → Haiku
//   - Substantial reasoning / explanation                            → Sonnet (typically)
//   - Hard multi-step derivation / cross-component reasoning         → Opus (or Sonnet)
//   - Background-analysis tasks (validation explanations, summaries) → Haiku/Sonnet
//
// The mix reflects the platform's actual AI usage shape: chat queries
// users send (mix of simple + substantial), validation explanations
// (background-analysis, bounded), reasoning-capture summaries (when
// they run). Not a synthetic worst-case or best-case set.

import type { AI_PURPOSES } from '@epagoge/shared';

export interface WorkloadQuery {
  readonly id: string;
  readonly category:
    | 'simple-factual'
    | 'substantial-reasoning'
    | 'hard-derivation'
    | 'background-analysis';
  readonly purpose: (typeof AI_PURPOSES)[number];
  readonly system?: string;
  readonly userMessage: string;
  /** Tier hints surfaced to the router (the router decides; these are inputs). */
  readonly hints: {
    readonly isSimple?: boolean;
    readonly needsReasoning?: boolean;
  };
}

export const WORKLOAD: readonly WorkloadQuery[] = [
  // ---- Simple factual / classification — should route to Haiku ----
  {
    id: 'q01-simple-factual',
    category: 'simple-factual',
    purpose: 'chat',
    userMessage: 'What does GELU stand for and what is its mathematical form?',
    hints: { isSimple: true },
  },
  {
    id: 'q02-simple-factual',
    category: 'simple-factual',
    purpose: 'chat',
    userMessage:
      'In a multi-head attention layer with 12 heads and embed_dim 768, what is the head dimension?',
    hints: { isSimple: true },
  },
  {
    id: 'q03-simple-classification',
    category: 'simple-factual',
    purpose: 'background-analysis',
    userMessage:
      'Classify this query as "factual", "reasoning", or "code-generation": "what is the default vocabulary size for GPT-2?"',
    hints: { isSimple: true },
  },
  {
    id: 'q04-simple-factual',
    category: 'simple-factual',
    purpose: 'chat',
    userMessage: 'Briefly: what is RMSNorm and how does it differ from LayerNorm?',
    hints: { isSimple: true },
  },

  // ---- Substantial reasoning — should route to Sonnet (mostly) ----
  {
    id: 'q05-substantial-reasoning',
    category: 'substantial-reasoning',
    purpose: 'chat',
    userMessage:
      'I am composing a Llama-style decoder block. Should I use GQA or MQA? Walk through the tradeoffs in terms of KV-cache size, training throughput, and downstream quality, and give me a default if I am not sure.',
    hints: { needsReasoning: true },
  },
  {
    id: 'q06-substantial-explanation',
    category: 'substantial-reasoning',
    purpose: 'chat',
    userMessage:
      'Explain how RoPE rotates Q and K by position-dependent angles and why this gives the model relative-position awareness without explicit positional embeddings.',
    hints: { needsReasoning: true },
  },
  {
    id: 'q07-substantial-validation-explain',
    category: 'background-analysis',
    purpose: 'background-analysis',
    userMessage:
      'Deterministic validator detected: divisibility — multi_head_attention has embed_dim=1024 num_heads=12 remainder=4. Explain the error and suggest concrete fixes the user can apply.',
    hints: { isSimple: true },
  },
  {
    id: 'q08-substantial-reasoning',
    category: 'substantial-reasoning',
    purpose: 'chat',
    userMessage:
      'I have an architecture with embedding -> position encoding (learned) -> 6 attention blocks -> layernorm -> output. Where should I add residual connections and why?',
    hints: { needsReasoning: true },
  },
  {
    id: 'q09-substantial-reasoning',
    category: 'substantial-reasoning',
    purpose: 'chat',
    userMessage:
      'For a 7B-parameter decoder-only model targeting long-context (32K tokens), should I use absolute sinusoidal PE, learned PE, RoPE, or ALiBi? Tradeoffs and a default recommendation.',
    hints: { needsReasoning: true },
  },

  // ---- Hard multi-step derivation / cross-component reasoning ----
  {
    id: 'q10-hard-derivation',
    category: 'hard-derivation',
    purpose: 'chat',
    userMessage:
      'Trace through a forward pass of an MoEFFN with 8 experts and top-2 routing: a batch of 4 sequences of length 16 with embed_dim 1024. At each step (router scoring, top-k selection, dispatch, per-expert forward, weighted recombination), describe what tensors exist and their shapes, and where load-balancing would break if all tokens routed to one expert.',
    hints: { needsReasoning: true },
  },
  {
    id: 'q11-hard-cross-component',
    category: 'hard-derivation',
    purpose: 'chat',
    userMessage:
      'In a SlidingWindowAttention layer with window_size=512 and ALiBi position bias, the boolean window mask and the ALiBi float bias mask interact. Derive the correct combined attn_mask the SDPA call should receive, and explain why is_causal=True and float attn_mask cannot be combined naively.',
    hints: { needsReasoning: true },
  },
  {
    id: 'q12-hard-architecture',
    category: 'hard-derivation',
    purpose: 'chat',
    userMessage:
      'I want to compose a vision-language model on this platform: a vision encoder feeding cross-attention into a text decoder. Sketch the component graph using only components from the catalog (Input, TokenEmbedding, PositionEmbedding, attention variants, FFN variants, normalization, Output), specify which ports connect where, and identify the shape constraints I need to satisfy at each connection.',
    hints: { needsReasoning: true },
  },

  // ---- Background-analysis bounded tasks ----
  {
    id: 'q13-background-summarize',
    category: 'background-analysis',
    purpose: 'background-analysis',
    userMessage:
      'Summarize this canvas-save record in 1-2 sentences: "User committed an architecture named \'Llama 7B baseline\' with 24 nodes and 27 edges, lifecycle position architecture, including 6 GQA layers with RoPE and SwiGLU FFNs."',
    hints: { isSimple: true },
  },
  {
    id: 'q14-background-explain',
    category: 'background-analysis',
    purpose: 'background-analysis',
    userMessage:
      'Deterministic validator detected: dtype-mismatch on edge e1. source emits int64, target expects float32. Explain in 2-3 sentences why this matters and the typical fix.',
    hints: { isSimple: true },
  },
  {
    id: 'q15-background-analysis',
    category: 'background-analysis',
    purpose: 'background-analysis',
    userMessage:
      'A user just renamed their lifecycle position from "architecture" to "training". Generate a one-line summary suitable for a chain-event log entry.',
    hints: { isSimple: true },
  },
];
