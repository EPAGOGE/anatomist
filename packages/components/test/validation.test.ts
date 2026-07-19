import { describe, it, expect } from 'vitest';
import {
  ComponentRegistry,
  loadMlDomain,
  validateGraph,
  validateProposedEdge,
  errorFingerprint,
  formatError,
  type GraphSpec,
  type ShapeMismatchError,
  type DivisibilityError,
  type ValidationError,
} from '../src/index.js';

// E5 deterministic validation tests. The validator is the SOURCE OF
// TRUTH for whether an architecture is valid (tier 1 of ADR-0032).
// These tests cover the error taxonomy + fingerprinting + the
// well-known transformer divisibility constraint patterns.

function buildRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  loadMlDomain(r);
  return r;
}

function emptyGraph(name = 'Test'): GraphSpec {
  return { version: 1, name, nodes: [], edges: [] };
}

describe('validateGraph — happy path', () => {
  const registry = buildRegistry();

  it('flags empty graph as valid (no errors; canvas surfaces emptiness elsewhere)', () => {
    const res = validateGraph(emptyGraph(), registry);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('flags minimal Input → Output as valid', () => {
    const g: GraphSpec = {
      version: 1,
      name: 'Pass-through',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        { id: 'n2', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portId: 'out' },
          target: { nodeId: 'n2', portId: 'in' },
        },
      ],
    };
    const res = validateGraph(g, registry);
    expect(res.valid).toBe(true);
  });
});

describe('validateGraph — error taxonomy', () => {
  const registry = buildRegistry();

  it('detects unknown-component', () => {
    const g: GraphSpec = {
      version: 1,
      name: 'Bad',
      nodes: [{ id: 'n1', componentId: 'ml.not_a_real_thing', properties: {} }],
      edges: [],
    };
    const res = validateGraph(g, registry);
    expect(res.valid).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.code).toBe('unknown-component');
  });

  it('detects unconnected required input port', () => {
    const g: GraphSpec = {
      version: 1,
      name: 'Dangling',
      nodes: [
        // LayerNorm needs `in` connected; we leave it dangling.
        {
          id: 'n1',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
      ],
      edges: [],
    };
    const res = validateGraph(g, registry);
    const errs = res.errors.filter((e) => e.code === 'unconnected-port');
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0]!.code).toBe('unconnected-port');
    if (errs[0]!.code === 'unconnected-port') {
      expect(errs[0]!.componentId).toBe('ml.layer_norm');
      expect(errs[0]!.portId).toBe('in');
    }
  });

  it('detects shape mismatch on cross-edge signature', () => {
    // Embedding outputs [batch, seq, embed_dim] float32 (named symbolic).
    // LayerNorm inputs are also named-symbolic so they match for compatibility.
    // To produce a shape mismatch we need an edge whose endpoints have
    // a numeric divergence — use ml.input with shape=batch,seq,4 then
    // a downstream LayerNorm whose embed_dim resolves the signature
    // to a different concrete value. But both ports use symbolic
    // names. So instead we use an Input with explicit 2D shape into
    // LayerNorm's input which expects 3D — that's a rank mismatch
    // which is also a shape-mismatch error.
    const g: GraphSpec = {
      version: 1,
      name: 'RankBad',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,4', dtype: 'float32' }, // 2D
        },
        {
          id: 'n2',
          componentId: 'ml.layer_norm', // expects 3D [batch,seq,embed_dim]
          properties: { normalized_shape: 4, eps: 1e-5 },
        },
        { id: 'n3', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portId: 'out' },
          target: { nodeId: 'n2', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n2', portId: 'out' },
          target: { nodeId: 'n3', portId: 'in' },
        },
      ],
    };
    const res = validateGraph(g, registry);
    const shape = res.errors.find((e): e is ShapeMismatchError => e.code === 'shape-mismatch');
    expect(shape).toBeDefined();
    expect(shape!.reason).toContain('rank');
  });

  it('detects dtype mismatch', () => {
    // Input emits int64 (default), but Embedding's `tokens` input is
    // int64 so that path works. Use an int64 Input into LayerNorm which
    // expects float32 — that's a dtype mismatch.
    const g: GraphSpec = {
      version: 1,
      name: 'DtypeBad',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'int64' },
        },
        {
          id: 'n2',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
        { id: 'n3', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portId: 'out' },
          target: { nodeId: 'n2', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n2', portId: 'out' },
          target: { nodeId: 'n3', portId: 'in' },
        },
      ],
    };
    const res = validateGraph(g, registry);
    const dt = res.errors.find((e) => e.code === 'dtype-mismatch');
    expect(dt).toBeDefined();
    if (dt && dt.code === 'dtype-mismatch') {
      expect(dt.sourceDtype).toBe('int64');
      expect(dt.targetDtype).toBe('float32');
    }
  });

  it('detects MHA divisibility violation with suggested fixes', () => {
    const g: GraphSpec = {
      version: 1,
      name: 'BadDivisibility',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'n2',
          componentId: 'ml.multi_head_attention',
          // 1024 / 12 = 85.33... — classic transformer authoring mistake.
          properties: { embed_dim: 1024, num_heads: 12, dropout: 0.0 },
        },
        { id: 'n3', componentId: 'ml.output', properties: {} },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portId: 'out' },
          target: { nodeId: 'n2', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n2', portId: 'out' },
          target: { nodeId: 'n3', portId: 'in' },
        },
      ],
    };
    const res = validateGraph(g, registry);
    const div = res.errors.find((e): e is DivisibilityError => e.code === 'divisibility');
    expect(div).toBeDefined();
    expect(div!.numerator.value).toBe(1024);
    expect(div!.denominator.value).toBe(12);
    expect(div!.remainder).toBe(1024 % 12);
    // The platform-priority list places 8 and 16 first among divisors of 1024
    // (priority order: 8, 16, ...). Both should appear in suggestions.
    expect(div!.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(div!.suggestions).toContain(8);
    expect(div!.suggestions).toContain(16);
    // Sanity: each suggestion must actually divide 1024 evenly.
    for (const s of div!.suggestions) {
      expect(1024 % s).toBe(0);
    }
  });

  it('detects cycles', () => {
    // Two LayerNorms with mutual edges. The graph never reaches an
    // Input/Output so we also expect unreachable errors not to fire
    // (the reachability check is gated on Inputs+Outputs being present).
    const g: GraphSpec = {
      version: 1,
      name: 'Cycle',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
        {
          id: 'n2',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portId: 'out' },
          target: { nodeId: 'n2', portId: 'in' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n2', portId: 'out' },
          target: { nodeId: 'n1', portId: 'in' },
        },
      ],
    };
    const res = validateGraph(g, registry);
    expect(res.errors.some((e) => e.code === 'cyclic-graph')).toBe(true);
  });

  it('detects unreachable nodes when both Input and Output exist', () => {
    // An Input → Output path AND a dangling LayerNorm not connected
    // to either. The lonely LayerNorm is unreachable from Input.
    const g: GraphSpec = {
      version: 1,
      name: 'Orphan',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        { id: 'n2', componentId: 'ml.output', properties: {} },
        {
          id: 'n3',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portId: 'out' },
          target: { nodeId: 'n2', portId: 'in' },
        },
      ],
    };
    const res = validateGraph(g, registry);
    expect(res.errors.some((e) => e.code === 'unreachable-node')).toBe(true);
  });
});

describe('errorFingerprint — stable across runtime node ids', () => {
  it('identical structural error produces identical fingerprint', () => {
    const a: ValidationError = {
      code: 'divisibility',
      nodeId: 'node-runtime-A',
      componentId: 'ml.multi_head_attention',
      numerator: { name: 'embed_dim', value: 1024 },
      denominator: { name: 'num_heads', value: 12 },
      remainder: 1024 % 12,
      suggestions: [8, 16],
    };
    const b: ValidationError = {
      code: 'divisibility',
      nodeId: 'totally-different-runtime-id',
      componentId: 'ml.multi_head_attention',
      numerator: { name: 'embed_dim', value: 1024 },
      denominator: { name: 'num_heads', value: 12 },
      remainder: 1024 % 12,
      suggestions: [8, 16],
    };
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it('different values produce different fingerprints', () => {
    const a: ValidationError = {
      code: 'shape-mismatch',
      edgeId: 'e1',
      sourceNodeId: 'n1',
      sourcePortId: 'out',
      targetNodeId: 'n2',
      targetPortId: 'in',
      sourceSignature: 'Tensor[batch,seq,128]:float32',
      targetSignature: 'Tensor[batch,seq,256]:float32',
      reason: 'dim 2: 128 vs 256',
    };
    const b: ValidationError = {
      ...a,
      sourceSignature: 'Tensor[batch,seq,64]:float32',
      reason: 'dim 2: 64 vs 256',
    };
    expect(errorFingerprint(a)).not.toBe(errorFingerprint(b));
  });
});

describe('validateProposedEdge — connection-time validation reuses validateGraph', () => {
  const registry = buildRegistry();

  it('returns null for a compatible edge between Input and LayerNorm', () => {
    // Pre-existing graph: just the two nodes, no edges yet.
    const g: GraphSpec = {
      version: 1,
      name: 'WIP',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'n2',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
      ],
      edges: [],
    };
    const result = validateProposedEdge(g, registry, {
      sourceNodeId: 'n1',
      sourcePortId: 'out',
      targetNodeId: 'n2',
      targetPortId: 'in',
    });
    expect(result).toBeNull();
  });

  it('returns shape-mismatch errors when proposed edge would create one', () => {
    // Input with 2D shape connecting into LayerNorm (3D expected) — rank mismatch.
    const g: GraphSpec = {
      version: 1,
      name: 'Bad',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq', dtype: 'float32' }, // 2D
        },
        {
          id: 'n2',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
      ],
      edges: [],
    };
    const result = validateProposedEdge(g, registry, {
      sourceNodeId: 'n1',
      sourcePortId: 'out',
      targetNodeId: 'n2',
      targetPortId: 'in',
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    expect(result![0]!.code).toBe('shape-mismatch');
  });

  it('returns dtype-mismatch errors with the same shape as panel errors', () => {
    const g: GraphSpec = {
      version: 1,
      name: 'DtypeBad',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'int64' },
        },
        {
          id: 'n2',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
      ],
      edges: [],
    };
    const result = validateProposedEdge(g, registry, {
      sourceNodeId: 'n1',
      sourcePortId: 'out',
      targetNodeId: 'n2',
      targetPortId: 'in',
    });
    expect(result).not.toBeNull();
    const dt = result!.find((e) => e.code === 'dtype-mismatch');
    expect(dt).toBeDefined();
    // Sub-shape matches the panel's error shape — same engine.
    if (dt && dt.code === 'dtype-mismatch') {
      expect(dt.sourceDtype).toBe('int64');
      expect(dt.targetDtype).toBe('float32');
    }
  });

  it('filters out pre-existing errors — only NEW errors are reported', () => {
    // Pre-existing divisibility error on MHA; proposed edge should not
    // re-report it.
    const g: GraphSpec = {
      version: 1,
      name: 'PreExisting',
      nodes: [
        {
          id: 'n1',
          componentId: 'ml.input',
          properties: { shape: 'batch,seq,embed_dim', dtype: 'float32' },
        },
        {
          id: 'n2',
          componentId: 'ml.layer_norm',
          properties: { normalized_shape: 768, eps: 1e-5 },
        },
        {
          // 1024 % 12 ≠ 0 — divisibility error already present.
          id: 'n3',
          componentId: 'ml.multi_head_attention',
          properties: { embed_dim: 1024, num_heads: 12, dropout: 0.0 },
        },
      ],
      // Edge n2→n3 is the proposed new one. n1→n2 already exists.
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portId: 'out' },
          target: { nodeId: 'n2', portId: 'in' },
        },
      ],
    };
    const result = validateProposedEdge(g, registry, {
      sourceNodeId: 'n2',
      sourcePortId: 'out',
      targetNodeId: 'n3',
      targetPortId: 'in',
    });
    // The divisibility error pre-exists; it should NOT appear in the
    // proposed-edge result. The edge itself is shape-compatible
    // (both signatures are [batch,seq,embed_dim] float32 symbolic),
    // so result should be null OR contain no divisibility entries.
    if (result !== null) {
      expect(result.find((e) => e.code === 'divisibility')).toBeUndefined();
    }
  });
});

describe('formatError — readable descriptions', () => {
  it('shape mismatch reads cleanly', () => {
    const err: ValidationError = {
      code: 'shape-mismatch',
      edgeId: 'e1',
      sourceNodeId: 'n1',
      sourcePortId: 'out',
      targetNodeId: 'n2',
      targetPortId: 'in',
      sourceSignature: 'Tensor[batch,4]:float32',
      targetSignature: 'Tensor[batch,seq,embed_dim]:float32',
      reason: 'rank: 2D cannot flow into 3D',
    };
    const s = formatError(err);
    expect(s).toContain('Shape mismatch');
    expect(s).toContain('e1');
    expect(s).toContain('Tensor[batch,4]:float32');
  });

  it('divisibility error includes both names + remainder', () => {
    const err: ValidationError = {
      code: 'divisibility',
      nodeId: 'n1',
      componentId: 'ml.multi_head_attention',
      numerator: { name: 'embed_dim', value: 1024 },
      denominator: { name: 'num_heads', value: 12 },
      remainder: 4,
      suggestions: [8, 16],
    };
    const s = formatError(err);
    expect(s).toContain('embed_dim=1024');
    expect(s).toContain('num_heads=12');
    expect(s).toContain('remainder 4');
  });
});
