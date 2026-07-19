// @epagoge/components — barrel re-exports.

export {
  ComponentRegistry,
  defaultRegistry,
  type ComponentSpec,
  type PortSpec,
  type PropertySpec,
  type PropertyKind,
  type PropertyValue,
  type PropertyGroup,
  type ResolvedProperties,
  type CodegenIR,
  type BackendFragment,
} from './registry/index.js';

export {
  DTYPES,
  DTypeSchema,
  TensorSignatureSchema,
  DimSchema,
  compareDim,
  isCompatible,
  formatSignature,
  type DType,
  type Dim,
  type TensorSignature,
} from './tensor/index.js';

export { loadMlDomain, ML_COMPONENTS } from './domains/ml/index.js';

export {
  validateGraph,
  validateProposedEdge,
  errorFingerprint,
  formatError,
  type ValidationResult,
  type ValidationError,
  type ShapeMismatchError,
  type DtypeMismatchError,
  type DivisibilityError,
  type UnconnectedPortError,
  type CyclicGraphError,
  type UnreachableNodeError,
  type UnknownComponentError,
} from './validation/index.js';

export type { GraphSpec, GraphNode, GraphEdge } from './validation/graph-types.js';
