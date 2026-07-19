// Public surface of the chain-ribbon module. The Layout mounts
// `RibbonContainer`; everything else is internal.

export { RibbonContainer, listRibbonVisualizers } from './RibbonContainer.js';
export { useRibbonEvents } from './useRibbonEvents.js';
export { iconForChain, colorsForChain, categorizeChain, eventTooltip } from './iconography.js';
export type {
  RibbonEvent,
  RibbonEventMeta,
  RibbonChainCategory,
  RibbonVisualizer,
  RibbonVisualizerProps,
} from './types.js';
