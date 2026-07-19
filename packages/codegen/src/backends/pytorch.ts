// PyTorch code generation backend.
//
// Takes a GraphSpec + a ComponentRegistry, returns a string of working
// PyTorch source. The emitted code defines one `nn.Module` subclass
// with `__init__` (assembled from each node's `init` fragment) and
// `forward` (assembled from each node's `forward` fragment in topo
// order). Imports are deduplicated.
//
// The generated module's `forward` takes one parameter per Input
// node. Output nodes terminate the forward with `return <var>`.
//
// This backend is one of (eventually) several. The contract is:
// `generate(graph, registry) -> string`. JAX, MLX, Triton, etc. land
// alongside via the same shape.
//
// E8 addition: the source-mapped form `generatePytorchWithSourceMap`
// emits the same code plus a per-node line-range map, enabling
// bidirectional canvas↔code navigation (click a node → highlight its
// lines; click a line → select its node). Per ADR-0035 the source map
// is part of the codegen surface, not an after-the-fact regex match
// — this keeps the mapping correct as backends evolve.

import { type ComponentRegistry, type ResolvedProperties } from '@epagoge/components';
import { topologicalSort, singleEdgeIntoPort, type GraphSpec } from '../graph/index.js';

const INDENT = '    ';

/**
 * Per-node line ranges within the generated source. Line numbers are
 * 1-indexed and INCLUSIVE — `[3, 5]` means lines 3, 4, and 5. A node
 * may contribute to both `init` and `forward` sections (most do); an
 * empty array means the node produced no lines in that section
 * (e.g. ml.input has no init line; ml.output's forward lands in the
 * combined `return` at the bottom).
 */
export interface NodeSourceRange {
  readonly nodeId: string;
  readonly initRanges: readonly (readonly [number, number])[];
  readonly forwardRanges: readonly (readonly [number, number])[];
}

/**
 * Generated source plus the per-node line map. The `code` field is
 * identical to what `generatePytorch` returns; consumers that want
 * bidirectional navigation use `nodeRanges` + `lineToNodeId`.
 */
export interface GeneratedSource {
  readonly code: string;
  readonly nodeRanges: ReadonlyMap<string, NodeSourceRange>;
  /** Reverse index: 1-indexed line number → owning node id. Lines
   *  that belong to boilerplate (class header, def lines, imports,
   *  blank lines) are absent from the map. */
  readonly lineToNodeId: ReadonlyMap<number, string>;
}

/**
 * Generate PyTorch source for one composed architecture.
 *
 * The generated module is named after `graph.name`, sanitized to a
 * valid Python identifier. If sanitization produces an empty string,
 * we fall back to `GeneratedModel`.
 */
export function generatePytorch(graph: GraphSpec, registry: ComponentRegistry): string {
  return generatePytorchWithSourceMap(graph, registry).code;
}

/**
 * Same as `generatePytorch` but additionally returns a per-node
 * source map for canvas↔code navigation. Use this when the caller
 * needs to highlight the lines belonging to a specific node, or
 * resolve a line number back to the node it came from.
 */
export function generatePytorchWithSourceMap(
  graph: GraphSpec,
  registry: ComponentRegistry,
): GeneratedSource {
  const className = sanitizeClassName(graph.name);
  const sorted = topologicalSort(graph);

  // Pre-assign each node a stable variable suffix based on its index
  // in topo order. Component-typed prefix keeps the generated code
  // readable: self.attn_2, self.norm_3, etc.
  const varNames = new Map<string, string>();
  const varCounts = new Map<string, number>();
  for (const node of sorted) {
    const spec = registry.require(node.componentId);
    const base = baseVarName(spec.id);
    const idx = (varCounts.get(base) ?? 0) + 1;
    varCounts.set(base, idx);
    varNames.set(node.id, `${base}_${idx}`);
  }

  // Per-port output variable assignment. When a node has output ports,
  // the codegen layer needs to know what variable name flowed out of
  // each port so downstream consumers can reference it. The convention:
  // `<nodeVar>_<portId>` (e.g. `embed_1_out`, `attn_2_attn`).
  const portOutputVar = (nodeId: string, portId: string): string =>
    `${varNames.get(nodeId)!}__${portId}`;

  // Find Input nodes — these become forward() parameters.
  const inputNodes = sorted.filter((n) => n.componentId === 'ml.input');
  if (inputNodes.length === 0) {
    throw new Error('graph has no ml.input node; nothing to feed forward');
  }
  // Stable param naming: the i-th input is `x{i}` (x0, x1, ...). Single
  // input becomes the bare `x` for ergonomics.
  const forwardParams = inputNodes.map((_, i) => (inputNodes.length === 1 ? 'x' : `x${i}`));

  // Inputs publish their forward-parameter name as their `out` port var.
  inputNodes.forEach((n, i) => {
    const paramName = forwardParams[i]!;
    // We record this mapping in a side table so the IR codegen below
    // doesn't need a special case — instead the `inputs` map passed to
    // a downstream forward fragment uses these names directly.
    inputPortPublishedNames.set(n.id + '|out', paramName);
  });

  // Collect imports + init lines + forward lines by walking topo order.
  // Output nodes are special: each one's `forward` fragment is
  // `return <var>`, and you can't have multiple returns in one
  // function. We DEFER all Output forward fragments and emit a
  // single combined return at the end:
  //   - 1 Output → `return <var>`
  //   - N Outputs → `return (<var1>, <var2>, ...)` (tuple)
  // The Output nodes still go through codegen for imports/init (both
  // empty in the ML primitive set today, but the contract supports
  // either) and for input-port resolution.
  const importsSet = new Set<string>();
  // Per-node init/forward fragments tagged with their node id. The
  // tag survives through line splitting + indentation so the final
  // assembly pass can build the source map.
  const initFragments: { nodeId: string; lines: string[] }[] = [];
  const forwardFragments: { nodeId: string; lines: string[] }[] = [];
  const outputReturnVars: string[] = [];
  // Track which nodes the combined return statement at the bottom
  // belongs to — usually one Output node; if multiple Outputs feed
  // the same return, all of them claim that line.
  const returnNodeIds: string[] = [];

  for (const node of sorted) {
    const spec = registry.require(node.componentId);
    const props: ResolvedProperties = node.properties as ResolvedProperties;
    const ir = spec.codegen(props);
    const fragment = ir.backends.pytorch;
    if (!fragment) {
      throw new Error(
        `component ${spec.id} has no pytorch backend fragment; cannot generate PyTorch code`,
      );
    }

    for (const imp of fragment.imports) importsSet.add(imp);

    const selfVar = `self.${varNames.get(node.id)!}`;
    const initLine = fragment.init(selfVar);
    if (initLine.trim().length > 0) {
      initFragments.push({
        nodeId: node.id,
        lines: initLine.split('\n').filter((l) => l.length > 0 || initLine.includes('\n')),
      });
    }

    // Resolve `inputs` map: input-port-id → upstream variable name.
    const inputs: Record<string, string> = {};
    for (const port of spec.inputs) {
      const edge = singleEdgeIntoPort(graph, node.id, port.id);
      if (!edge) {
        throw new Error(`node ${node.id} (${spec.id}) input port "${port.id}" is unconnected`);
      }
      // The upstream port's published variable name. For an upstream
      // Input node, that's the forward parameter (x, x0, x1...). For
      // any other upstream, it's the per-port output var.
      const upstreamKey = `${edge.source.nodeId}|${edge.source.portId}`;
      const fromInput = inputPortPublishedNames.get(upstreamKey);
      inputs[port.id] = fromInput ?? portOutputVar(edge.source.nodeId, edge.source.portId);
    }

    // Output nodes contribute their incoming var to the combined
    // return rather than emitting a forward fragment inline.
    if (node.componentId === 'ml.output') {
      const incoming = inputs.in;
      if (incoming !== undefined) outputReturnVars.push(incoming);
      returnNodeIds.push(node.id);
      continue;
    }

    // Resolve `outputs` map: output-port-id → variable name to assign.
    const outputs: Record<string, string> = {};
    for (const port of spec.outputs) {
      outputs[port.id] = portOutputVar(node.id, port.id);
    }

    const fwdLine = fragment.forward(selfVar, inputs, outputs);
    if (fwdLine.trim().length > 0) {
      forwardFragments.push({
        nodeId: node.id,
        lines: fwdLine.split('\n').filter((l) => l.length > 0 || fwdLine.includes('\n')),
      });
    }
  }

  // Assemble line-by-line with source tagging. Each entry of `lines`
  // is (content, owningNodeId|null). When owningNodeId is non-null,
  // that line lands in the per-node range; null marks boilerplate
  // (imports, class/def headers, blank separators, super().__init__).
  const lines: { content: string; nodeId: string | null }[] = [];

  // Imports — sorted for determinism. Boilerplate.
  for (const imp of Array.from(importsSet).sort()) {
    lines.push({ content: imp, nodeId: null });
  }
  // Two blank lines between imports and class definition (PEP 8).
  lines.push({ content: '', nodeId: null });
  lines.push({ content: '', nodeId: null });

  // Class + __init__ header.
  lines.push({ content: `class ${className}(nn.Module):`, nodeId: null });
  lines.push({ content: `${INDENT}def __init__(self):`, nodeId: null });
  lines.push({ content: `${INDENT}${INDENT}super().__init__()`, nodeId: null });

  // Init body — one block per node fragment. `pass` if empty.
  if (initFragments.length === 0) {
    lines.push({ content: `${INDENT}${INDENT}pass`, nodeId: null });
  } else {
    for (const frag of initFragments) {
      for (const ln of frag.lines) {
        lines.push({ content: `${INDENT}${INDENT}${ln}`, nodeId: frag.nodeId });
      }
    }
  }

  // Blank separator between __init__ and forward.
  lines.push({ content: '', nodeId: null });

  // forward header.
  lines.push({
    content: `${INDENT}def forward(self, ${forwardParams.join(', ')}):`,
    nodeId: null,
  });

  // Forward body.
  for (const frag of forwardFragments) {
    for (const ln of frag.lines) {
      lines.push({ content: `${INDENT}${INDENT}${ln}`, nodeId: frag.nodeId });
    }
  }

  // Combined return at the bottom. No Outputs → no return (caller's
  // problem; the codegen produces a valid module that just doesn't
  // return anything explicitly). One Output → `return v`. Many → tuple.
  if (outputReturnVars.length === 1) {
    const returnNodeId = returnNodeIds[0] ?? null;
    lines.push({
      content: `${INDENT}${INDENT}return ${outputReturnVars[0]!}`,
      nodeId: returnNodeId,
    });
  } else if (outputReturnVars.length > 1) {
    // Tuple return belongs to the first output node by convention;
    // visually highlighting one node when many are involved keeps
    // the click feedback clean. The semantic owner-set is recorded
    // in returnNodeIds, but only the first claims the line.
    lines.push({
      content: `${INDENT}${INDENT}return (${outputReturnVars.join(', ')})`,
      nodeId: returnNodeIds[0] ?? null,
    });
  }

  // Reset per-call state.
  inputPortPublishedNames.clear();

  // Build the source map alongside the final string. Line numbers
  // are 1-indexed (Monaco convention).
  const nodeRanges = new Map<string, NodeSourceRange>();
  const lineToNodeId = new Map<number, string>();

  // Track running ranges per node + section. We compact consecutive
  // same-node lines into a single (start, end) tuple.
  type RangeAccumulator = {
    initRanges: [number, number][];
    forwardRanges: [number, number][];
    currentInit: [number, number] | null;
    currentForward: [number, number] | null;
  };
  const acc = new Map<string, RangeAccumulator>();
  function getAcc(id: string): RangeAccumulator {
    let a = acc.get(id);
    if (!a) {
      a = { initRanges: [], forwardRanges: [], currentInit: null, currentForward: null };
      acc.set(id, a);
    }
    return a;
  }

  // Find the forward def line so we know which section each tagged
  // line belongs to. The forward header is always exactly one line
  // and we identified its content; scan once.
  const forwardHeaderIdx = lines.findIndex((l) =>
    l.content.startsWith(`${INDENT}def forward(self`),
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.nodeId) continue;
    const lineNo = i + 1;
    lineToNodeId.set(lineNo, line.nodeId);
    const a = getAcc(line.nodeId);
    const inForwardSection = forwardHeaderIdx !== -1 && i > forwardHeaderIdx;
    if (inForwardSection) {
      if (a.currentForward && a.currentForward[1] === lineNo - 1) {
        a.currentForward = [a.currentForward[0], lineNo];
      } else {
        if (a.currentForward) a.forwardRanges.push(a.currentForward);
        a.currentForward = [lineNo, lineNo];
      }
    } else {
      if (a.currentInit && a.currentInit[1] === lineNo - 1) {
        a.currentInit = [a.currentInit[0], lineNo];
      } else {
        if (a.currentInit) a.initRanges.push(a.currentInit);
        a.currentInit = [lineNo, lineNo];
      }
    }
  }
  // Flush trailing ranges.
  for (const [id, a] of acc.entries()) {
    if (a.currentInit) a.initRanges.push(a.currentInit);
    if (a.currentForward) a.forwardRanges.push(a.currentForward);
    nodeRanges.set(id, {
      nodeId: id,
      initRanges: a.initRanges,
      forwardRanges: a.forwardRanges,
    });
  }

  // Trailing newline keeps the file diff-friendly.
  const code = lines.map((l) => l.content).join('\n') + '\n';

  return { code, nodeRanges, lineToNodeId };
}

// Module-scoped — reset per call. Cleaner than threading a state object
// through every helper.
const inputPortPublishedNames = new Map<string, string>();

function sanitizeClassName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (cleaned.length === 0) return 'GeneratedModel';
  // Title-case the words then concatenate.
  return cleaned
    .split(/\s+/)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
}

function baseVarName(componentId: string): string {
  // 'ml.multi_head_attention' → 'multi_head_attention' → 'attn' (well-known prefix)
  const tail = componentId.replace(/^ml\./, '');
  const aliases: Record<string, string> = {
    multi_head_attention: 'attn',
    multi_query_attention: 'mqa',
    grouped_query_attention: 'gqa',
    flash_attention: 'flash',
    sliding_window_attention: 'swa',
    cross_attention: 'xattn',
    absolute_position_encoding: 'abs_pos',
    learned_position_encoding: 'pos_emb',
    layer_norm: 'norm',
    rms_norm: 'rms',
    feedforward: 'ff',
    gated_ffn: 'gated_ffn',
    moe_ffn: 'moe',
    relu: 'act',
    gelu: 'act',
    silu: 'act',
    embedding: 'embed',
    position_embedding: 'pos_embed',
    segment_embedding: 'seg_embed',
    input: 'in',
    output: 'out',
  };
  return aliases[tail] ?? tail;
}
