import { describe, it, expect } from 'vitest';
import { ComponentRegistry, loadMlDomain } from '@epagoge/components';
import {
  generatePytorch,
  generatePytorchWithSourceMap,
  topologicalSort,
  type GraphSpec,
} from '../src/index.js';

function buildRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  loadMlDomain(r);
  return r;
}

/**
 * Tiny graph: Input → Embedding → Output. The smallest valid composition.
 */
const tinyGraph: GraphSpec = {
  version: 1,
  name: 'Tiny',
  nodes: [
    { id: 'n_in', componentId: 'ml.input', properties: { shape: 'batch,seq', dtype: 'int64' } },
    {
      id: 'n_emb',
      componentId: 'ml.embedding',
      properties: { vocab_size: 32000, embed_dim: 512 },
    },
    { id: 'n_out', componentId: 'ml.output', properties: {} },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'n_in', portId: 'out' },
      target: { nodeId: 'n_emb', portId: 'tokens' },
    },
    {
      id: 'e2',
      source: { nodeId: 'n_emb', portId: 'out' },
      target: { nodeId: 'n_out', portId: 'in' },
    },
  ],
};

/**
 * Pre-norm transformer block: Input → Embedding → LayerNorm → MHA → FF → Output.
 * A realistic exercise — proves the whole pipeline (topo, vars, imports,
 * init lines, forward lines) actually composes.
 */
const blockGraph: GraphSpec = {
  version: 1,
  name: 'Pre Norm Block',
  nodes: [
    { id: 'n1', componentId: 'ml.input', properties: { shape: 'batch,seq', dtype: 'int64' } },
    {
      id: 'n2',
      componentId: 'ml.embedding',
      properties: { vocab_size: 50257, embed_dim: 768 },
    },
    {
      id: 'n3',
      componentId: 'ml.layer_norm',
      properties: { normalized_shape: 768, eps: 1e-5 },
    },
    {
      id: 'n4',
      componentId: 'ml.multi_head_attention',
      properties: { embed_dim: 768, num_heads: 12, dropout: 0.0 },
    },
    {
      id: 'n5',
      componentId: 'ml.feedforward',
      properties: { embed_dim: 768, hidden_dim: 3072, activation: 'gelu', bias: true },
    },
    { id: 'n6', componentId: 'ml.output', properties: {} },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'n1', portId: 'out' },
      target: { nodeId: 'n2', portId: 'tokens' },
    },
    { id: 'e2', source: { nodeId: 'n2', portId: 'out' }, target: { nodeId: 'n3', portId: 'in' } },
    { id: 'e3', source: { nodeId: 'n3', portId: 'out' }, target: { nodeId: 'n4', portId: 'in' } },
    { id: 'e4', source: { nodeId: 'n4', portId: 'out' }, target: { nodeId: 'n5', portId: 'in' } },
    { id: 'e5', source: { nodeId: 'n5', portId: 'out' }, target: { nodeId: 'n6', portId: 'in' } },
  ],
};

describe('topologicalSort', () => {
  it('returns sources before sinks', () => {
    const ordered = topologicalSort(tinyGraph);
    const ids = ordered.map((n) => n.id);
    expect(ids.indexOf('n_in')).toBeLessThan(ids.indexOf('n_emb'));
    expect(ids.indexOf('n_emb')).toBeLessThan(ids.indexOf('n_out'));
  });

  it('detects a cycle', () => {
    const cyclic: GraphSpec = {
      version: 1,
      name: 'cycle',
      nodes: [
        { id: 'a', componentId: 'ml.layer_norm', properties: {} },
        { id: 'b', componentId: 'ml.layer_norm', properties: {} },
      ],
      edges: [
        { id: 'e1', source: { nodeId: 'a', portId: 'out' }, target: { nodeId: 'b', portId: 'in' } },
        { id: 'e2', source: { nodeId: 'b', portId: 'out' }, target: { nodeId: 'a', portId: 'in' } },
      ],
    };
    expect(() => topologicalSort(cyclic)).toThrow(/cycle/);
  });

  it('detects unknown node references', () => {
    const bad: GraphSpec = {
      version: 1,
      name: 'orphan',
      nodes: [{ id: 'a', componentId: 'ml.layer_norm', properties: {} }],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portId: 'out' },
          target: { nodeId: 'ghost', portId: 'in' },
        },
      ],
    };
    expect(() => topologicalSort(bad)).toThrow(/unknown node/);
  });

  it('determinism: same graph → same order across calls', () => {
    const r1 = topologicalSort(blockGraph).map((n) => n.id);
    const r2 = topologicalSort(blockGraph).map((n) => n.id);
    expect(r1).toEqual(r2);
  });
});

describe('generatePytorch', () => {
  it('emits a valid-looking module for the tiny graph', () => {
    const code = generatePytorch(tinyGraph, buildRegistry());
    expect(code).toContain('import torch');
    expect(code).toContain('import torch.nn as nn');
    expect(code).toContain('class Tiny(nn.Module):');
    expect(code).toContain('def __init__(self):');
    expect(code).toContain('super().__init__()');
    expect(code).toContain('self.embed_1 = nn.Embedding(32000, 512)');
    expect(code).toContain('def forward(self, x):');
    expect(code).toContain('= self.embed_1(x)');
    expect(code).toContain('return');
  });

  it('emits a working pre-norm transformer block', () => {
    const code = generatePytorch(blockGraph, buildRegistry());
    // Imports deduplicated even though every node lists them.
    const importLines = code.split('\n').filter((l) => l.startsWith('import '));
    expect(new Set(importLines).size).toBe(importLines.length);
    // All five real components have init lines (Input + Output produce
    // no init).
    expect(code).toContain('nn.Embedding(50257, 768)');
    expect(code).toContain('nn.LayerNorm(768, eps=0.00001)');
    expect(code).toContain('nn.MultiheadAttention(768, 12');
    expect(code).toContain('nn.Linear(768, 3072');
    expect(code).toContain('nn.Linear(3072, 768');
    // forward order matches topo order.
    const fwdSection = code.split('def forward')[1]!;
    const idxEmbed = fwdSection.indexOf('self.embed_1');
    const idxNorm = fwdSection.indexOf('self.norm_1');
    const idxAttn = fwdSection.indexOf('self.attn_1');
    const idxFf = fwdSection.indexOf('self.ff_1');
    expect(idxEmbed).toBeGreaterThan(-1);
    expect(idxNorm).toBeGreaterThan(idxEmbed);
    expect(idxAttn).toBeGreaterThan(idxNorm);
    expect(idxFf).toBeGreaterThan(idxAttn);
    // Class name sanitized.
    expect(code).toContain('class PreNormBlock(nn.Module):');
  });

  it('throws if a required input port is unconnected', () => {
    // Graph has an Input node (so the "no input" guard passes), routes
    // it through LayerNorm → Output. Embedding is present but orphaned
    // — neither its `tokens` input nor its `out` output is connected.
    // Codegen should reach Embedding via topo order and fail on the
    // unconnected `tokens` port.
    const broken: GraphSpec = {
      version: 1,
      name: 'broken',
      nodes: [
        {
          id: 'in1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'orphan',
          componentId: 'ml.embedding',
          properties: { vocab_size: 100, embed_dim: 8 },
        },
        { id: 'norm', componentId: 'ml.layer_norm', properties: { normalized_shape: 768 } },
        { id: 'out1', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portId: 'out' },
          target: { nodeId: 'norm', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'norm', portId: 'out' },
          target: { nodeId: 'out1', portId: 'in' },
        },
      ],
    };
    expect(() => generatePytorch(broken, buildRegistry())).toThrow(/unconnected/);
  });

  it('falls back to GeneratedModel when name has no alphanumerics', () => {
    const code = generatePytorch({ ...tinyGraph, name: '   ' }, buildRegistry());
    expect(code).toContain('class GeneratedModel(nn.Module):');
  });

  // Multi-input + multi-output. Two Input nodes each feeding a
  // LayerNorm, each LayerNorm feeding its own Output. Codegen must:
  //   - emit forward(self, x0, x1)
  //   - emit a tuple return: `return (norm_1__out, norm_2__out)`
  //   - NOT emit two separate `return` statements (only the first is
  //     reachable).
  // This is the regression test for E2-5.
  it('emits multi-input forward params + tuple return for multi-output', () => {
    const multiIO: GraphSpec = {
      version: 1,
      name: 'Two Stream',
      nodes: [
        {
          id: 'in_a',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'in_b',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        { id: 'norm_a', componentId: 'ml.layer_norm', properties: { normalized_shape: 768 } },
        { id: 'norm_b', componentId: 'ml.layer_norm', properties: { normalized_shape: 768 } },
        { id: 'out_a', componentId: 'ml.output', properties: {} },
        { id: 'out_b', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_a', portId: 'out' },
          target: { nodeId: 'norm_a', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'in_b', portId: 'out' },
          target: { nodeId: 'norm_b', portId: 'in' },
        },
        {
          id: 'e3',
          source: { nodeId: 'norm_a', portId: 'out' },
          target: { nodeId: 'out_a', portId: 'in' },
        },
        {
          id: 'e4',
          source: { nodeId: 'norm_b', portId: 'out' },
          target: { nodeId: 'out_b', portId: 'in' },
        },
      ],
    };
    const code = generatePytorch(multiIO, buildRegistry());

    // Two inputs → x0, x1.
    expect(code).toMatch(/def forward\(self, x0, x1\):/);

    // Two outputs → a single tuple return at the end.
    const returnMatches = code.match(/^\s+return /gm) ?? [];
    expect(returnMatches.length).toBe(1);
    expect(code).toMatch(/return \(\w+__out, \w+__out\)/);

    // Each LayerNorm referenced via its own variable.
    expect(code).toContain('self.norm_1');
    expect(code).toContain('self.norm_2');
  });

  it('single Output still emits a bare `return var`', () => {
    // Sanity: the tuple form only activates for >1 Output. One
    // Output is still `return var` (not `return (var,)`).
    const code = generatePytorch(tinyGraph, buildRegistry());
    const returnMatches = code.match(/^\s+return /gm) ?? [];
    expect(returnMatches.length).toBe(1);
    expect(code).not.toMatch(/return \(/);
  });

  // E3-1 codegen smoke: real graph using GroupedQueryAttention.
  // Verifies the new attention variants compose into the existing
  // codegen pipeline without surprises.
  it('codegens a GQA-based decoder block end-to-end', () => {
    const gqaGraph: GraphSpec = {
      version: 1,
      name: 'GQA Block',
      nodes: [
        { id: 'i', componentId: 'ml.input', properties: { shape: 'batch,seq', dtype: 'int64' } },
        {
          id: 'e',
          componentId: 'ml.embedding',
          properties: { vocab_size: 32000, embed_dim: 1024 },
        },
        { id: 'n', componentId: 'ml.layer_norm', properties: { normalized_shape: 1024 } },
        {
          id: 'a',
          componentId: 'ml.grouped_query_attention',
          properties: {
            embed_dim: 1024,
            num_heads: 16,
            num_kv_heads: 4,
            dropout: 0.0,
            is_causal: true,
          },
        },
        { id: 'o', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i', portId: 'out' },
          target: { nodeId: 'e', portId: 'tokens' },
        },
        { id: 'e2', source: { nodeId: 'e', portId: 'out' }, target: { nodeId: 'n', portId: 'in' } },
        { id: 'e3', source: { nodeId: 'n', portId: 'out' }, target: { nodeId: 'a', portId: 'in' } },
        { id: 'e4', source: { nodeId: 'a', portId: 'out' }, target: { nodeId: 'o', portId: 'in' } },
      ],
    };
    const code = generatePytorch(gqaGraph, buildRegistry());
    // sanitizeClassName preserves all-caps acronyms.
    expect(code).toContain('class GQABlock(nn.Module):');
    // GQA constructor lines.
    expect(code).toContain('nn.Linear(1024, 4 * (1024 // 16))');
    // GQA forward uses repeat_interleave for kv-head broadcast.
    expect(code).toContain('repeat_interleave');
    expect(code).toContain('F.scaled_dot_product_attention');
    expect(code).toContain('is_causal=True');
  });

  // E3-1 cross-attention is the platform's first multi-input
  // production component. Verifies the canvas's multi-input plumbing
  // (from E2-5) composes with the new attention variant.
  it('codegens an encoder-decoder cross-attention head', () => {
    const xGraph: GraphSpec = {
      version: 1,
      name: 'XAttn Head',
      nodes: [
        {
          id: 'q_in',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq_q,embed_dim', dtype: 'float32' },
        },
        {
          id: 'kv_in',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq_kv,embed_dim', dtype: 'float32' },
        },
        {
          id: 'xa',
          componentId: 'ml.cross_attention',
          properties: { embed_dim: 768, num_heads: 12, dropout: 0.0 },
        },
        { id: 'out', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'q_in', portId: 'out' },
          target: { nodeId: 'xa', portId: 'query' },
        },
        {
          id: 'e2',
          source: { nodeId: 'kv_in', portId: 'out' },
          target: { nodeId: 'xa', portId: 'key_value' },
        },
        {
          id: 'e3',
          source: { nodeId: 'xa', portId: 'out' },
          target: { nodeId: 'out', portId: 'in' },
        },
      ],
    };
    const code = generatePytorch(xGraph, buildRegistry());
    // Two-Input → forward(self, x0, x1).
    expect(code).toMatch(/def forward\(self, x0, x1\):/);
    // CrossAttention init uses nn.MultiheadAttention.
    expect(code).toContain('nn.MultiheadAttention(768, 12');
    // Forward call: q (one input), k=v (other input).
    expect(code).toMatch(/self\.\w+\(x0, x1, x1\)|self\.\w+\(x1, x0, x0\)/);
  });
});

describe('generatePytorchWithSourceMap — bidirectional navigation', () => {
  it('produces identical code to generatePytorch', () => {
    const registry = buildRegistry();
    const a = generatePytorch(tinyGraph, registry);
    const b = generatePytorchWithSourceMap(tinyGraph, registry).code;
    expect(b).toBe(a);
  });

  it('returns a non-empty node range for each non-boilerplate node', () => {
    const registry = buildRegistry();
    const { nodeRanges } = generatePytorchWithSourceMap(tinyGraph, registry);
    // Embedding has an init line and a forward line.
    const emb = nodeRanges.get('n_emb');
    expect(emb).toBeDefined();
    expect(emb!.initRanges.length).toBe(1);
    expect(emb!.forwardRanges.length).toBe(1);
    // Output appears on the return line (forward-section).
    const out = nodeRanges.get('n_out');
    expect(out).toBeDefined();
    expect(out!.forwardRanges.length).toBeGreaterThanOrEqual(1);
  });

  it('lineToNodeId resolves arbitrary lines back to their node', () => {
    const registry = buildRegistry();
    const { code, lineToNodeId, nodeRanges } = generatePytorchWithSourceMap(tinyGraph, registry);
    const codeLines = code.split('\n');
    // Find the embedding init line — should contain `nn.Embedding`.
    const embInitLine = codeLines.findIndex((l) => l.includes('nn.Embedding')) + 1;
    expect(embInitLine).toBeGreaterThan(0);
    expect(lineToNodeId.get(embInitLine)).toBe('n_emb');
    // Find the forward line that uses the embedding — `= self.embed_1(x)`.
    const embFwdLine = codeLines.findIndex((l) => /=\s*self\.embed_1\(x\)/.test(l)) + 1;
    expect(embFwdLine).toBeGreaterThan(0);
    expect(lineToNodeId.get(embFwdLine)).toBe('n_emb');
    // The init range we returned should include that init line.
    const emb = nodeRanges.get('n_emb')!;
    const [initStart, initEnd] = emb.initRanges[0]!;
    expect(initStart).toBeLessThanOrEqual(embInitLine);
    expect(initEnd).toBeGreaterThanOrEqual(embInitLine);
  });

  it('boilerplate lines (imports, class header, blank separators) are NOT in lineToNodeId', () => {
    const registry = buildRegistry();
    const { code, lineToNodeId } = generatePytorchWithSourceMap(tinyGraph, registry);
    const codeLines = code.split('\n');
    // `import torch` is boilerplate.
    const importLine = codeLines.findIndex((l) => l === 'import torch') + 1;
    expect(importLine).toBeGreaterThan(0);
    expect(lineToNodeId.has(importLine)).toBe(false);
    // The class declaration is boilerplate.
    const classLine = codeLines.findIndex((l) => l.startsWith('class ')) + 1;
    expect(lineToNodeId.has(classLine)).toBe(false);
    // The forward def itself is boilerplate; its body is not.
    const fwdHeader = codeLines.findIndex((l) => l.match(/def forward\(self/)) + 1;
    expect(lineToNodeId.has(fwdHeader)).toBe(false);
  });

  it('multi-line component fragments produce contiguous line ranges', () => {
    const registry = buildRegistry();
    // MHA with PE='rope' emits a multi-line forward fragment.
    const ropeGraph: GraphSpec = {
      version: 1,
      name: 'Rope',
      nodes: [
        {
          id: 'n_in',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'n_mha',
          componentId: 'ml.multi_head_attention',
          properties: {
            embed_dim: 768,
            num_heads: 12,
            dropout: 0.0,
            position_encoding: 'rope',
            rope_base: 10000.0,
          },
        },
        { id: 'n_out', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n_in', portId: 'out' },
          target: { nodeId: 'n_mha', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n_mha', portId: 'out' },
          target: { nodeId: 'n_out', portId: 'in' },
        },
      ],
    };
    const { nodeRanges } = generatePytorchWithSourceMap(ropeGraph, registry);
    const mha = nodeRanges.get('n_mha')!;
    expect(mha.initRanges.length).toBe(1);
    expect(mha.forwardRanges.length).toBe(1);
    // The forward fragment has many lines for rope's pre-attn block.
    const [fStart, fEnd] = mha.forwardRanges[0]!;
    expect(fEnd - fStart).toBeGreaterThan(5); // RoPE forward has 10+ lines
  });
});
