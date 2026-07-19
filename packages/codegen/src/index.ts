// @epagoge/codegen — barrel re-exports.

export {
  GraphSpecSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  topologicalSort,
  edgesIntoPort,
  singleEdgeIntoPort,
  type GraphSpec,
  type GraphNode,
  type GraphEdge,
} from './graph/index.js';

export {
  generatePytorch,
  generatePytorchWithSourceMap,
  type GeneratedSource,
  type NodeSourceRange,
} from './backends/pytorch.js';
