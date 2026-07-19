// Typed wrappers for the SAE sidecar endpoints (apps/sae-backend/routes/sae.py).

import { saeFetch } from './sae-client.js';
import type { TopToken } from './mi-endpoints.js';

export interface SaeFeatureEntry {
  feature: number;
  activation: number;
  /** Tokens this feature's decoder direction promotes — its self-label. */
  label_tokens: string[];
}

export interface SaeFeaturesResponse {
  model_id: string;
  layer: number;
  tokens: string[];
  position: number;
  features: SaeFeatureEntry[];
  /** Reconstruction canary: fraction of variance unexplained (~0.1 = healthy). */
  fvu: number;
  /** Mean active features per token. */
  l0: number;
  d_sae: number;
  hook_name: string;
  stub: boolean;
  note?: string | null;
}

export async function getSaeFeatures(req: {
  model_id: string;
  prompt: string;
  layer: number;
  top_k?: number;
}): Promise<SaeFeaturesResponse> {
  return saeFetch<SaeFeaturesResponse>('/sae/features', { method: 'POST', body: req });
}

export interface SaeAblateResponse {
  model_id: string;
  layer: number;
  feature: number;
  label_tokens: string[];
  clean_top: TopToken[];
  ablated_top: TopToken[];
  stub: boolean;
  note?: string | null;
}

export async function saeAblateFeature(req: {
  model_id: string;
  prompt: string;
  layer: number;
  feature: number;
  top_k?: number;
}): Promise<SaeAblateResponse> {
  return saeFetch<SaeAblateResponse>('/sae/ablate', { method: 'POST', body: req });
}
