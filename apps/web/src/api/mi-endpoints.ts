// Typed wrappers for MI Workbench backend endpoints.
//
// Mirrors the contracts defined in apps/mi-backend/mi_backend/routes/*.
// Keep types in sync — when the backend's pydantic models change, the
// corresponding interfaces here change too. The whole point is one place
// to look for "what does the backend send."

import { miFetch } from './mi-client.js';

// ---------- Models (Subsystem 1) ----------

export interface ToolAvailability {
  transformer_lens: boolean;
  gemma_scope: boolean;
  nla_anthropic: boolean;
  custom_saes: boolean;
}

export interface ModelEntry {
  id: string;
  display_name: string;
  family: string;
  params_b: number;
  license: string;
  gated: boolean;
  tools: ToolAvailability;
  notes: string;
}

export interface ModelsListResponse {
  models: ModelEntry[];
}

export interface LoadedListResponse {
  loaded: string[];
}

export interface LoadResponse {
  status: string;
  model: string;
}

export async function listModels(): Promise<ModelsListResponse> {
  return miFetch<ModelsListResponse>('/models');
}

export async function getLoadedModels(): Promise<LoadedListResponse> {
  return miFetch<LoadedListResponse>('/models/loaded');
}

export async function loadModel(modelId: string): Promise<LoadResponse> {
  return miFetch<LoadResponse>(`/models/${encodeURIComponent(modelId)}/load`, {
    method: 'POST',
    body: {},
  });
}

export async function unloadModel(
  modelId: string,
): Promise<{ status: string; model: string; unloaded: boolean }> {
  return miFetch<{ status: string; model: string; unloaded: boolean }>(
    `/models/${encodeURIComponent(modelId)}`,
    { method: 'DELETE' },
  );
}

// ---------- Probe (Subsystem 3) ----------

export interface AttentionPatternRequest {
  model_id: string;
  prompt: string;
  layer: number;
  head: number;
}

export interface AttentionPatternResponse {
  model_id: string;
  layer: number;
  head: number;
  tokens: string[];
  pattern: number[][];
  stub: boolean;
  /** Set on stub responses to explain WHY real execution was unavailable
   *  (e.g. "transformer-lens not installed", "model load failed: ..."). */
  note?: string | null;
}

export async function getAttentionPattern(
  req: AttentionPatternRequest,
): Promise<AttentionPatternResponse> {
  return miFetch<AttentionPatternResponse>('/probe/attention_pattern', {
    method: 'POST',
    body: req,
  });
}

// ---------- Activations ----------

export interface ActivationsRequest {
  model_id: string;
  prompt: string;
  layer: number;
  site?: 'resid_pre' | 'resid_mid' | 'resid_post' | 'attn_out' | 'mlp_out';
}

export interface ActivationsResponse {
  model_id: string;
  layer: number;
  site: string;
  tokens: string[];
  shape: number[];
  /** Real-path only: per-token L2 norms (length T). */
  norms?: number[] | null;
  stub: boolean;
  note?: string | null;
}

export async function getActivations(req: ActivationsRequest): Promise<ActivationsResponse> {
  return miFetch<ActivationsResponse>('/probe/activations', {
    method: 'POST',
    body: req,
  });
}

// ---------- Logit lens ----------

export interface LogitLensRequest {
  model_id: string;
  prompt: string;
  layer: number;
  top_k?: number;
}

export interface TopToken {
  token: string;
  logit: number;
  prob: number;
}

export interface LogitLensResponse {
  model_id: string;
  layer: number;
  top_tokens: TopToken[];
  stub: boolean;
  note?: string | null;
}

export async function getLogitLens(req: LogitLensRequest): Promise<LogitLensResponse> {
  return miFetch<LogitLensResponse>('/probe/logit_lens', {
    method: 'POST',
    body: req,
  });
}

// ---------- Head ablation (Intervene) ----------

export interface AblateHeadRequest {
  model_id: string;
  prompt: string;
  layer: number;
  head: number;
  top_k?: number;
}

export interface AblateHeadResponse {
  model_id: string;
  layer: number;
  head: number;
  clean_top: TopToken[];
  ablated_top: TopToken[];
  stub: boolean;
  note?: string | null;
}

export async function ablateHead(req: AblateHeadRequest): Promise<AblateHeadResponse> {
  return miFetch<AblateHeadResponse>('/probe/ablate_head', {
    method: 'POST',
    body: req,
  });
}

// ---------- Head importance sweep (Intervene) ----------

export interface AblateSweepRequest {
  model_id: string;
  prompt: string;
}

export interface HeadEffect {
  layer: number;
  head: number;
  effect: number;
}

export interface AblateSweepResponse {
  model_id: string;
  n_layers: number;
  n_heads: number;
  clean_top_token: string;
  /** grid[layer][head] = effect (KL divergence between clean and ablated). */
  grid: number[][];
  top_movers: HeadEffect[];
  stub: boolean;
  note?: string | null;
}

export async function ablateSweep(req: AblateSweepRequest): Promise<AblateSweepResponse> {
  return miFetch<AblateSweepResponse>('/probe/ablate_sweep', {
    method: 'POST',
    body: req,
  });
}

// ---------- Activation patching (Intervene) ----------

export interface PatchRequest {
  model_id: string;
  clean_prompt: string;
  corrupted_prompt: string;
  answer: string;
  corrupted_answer: string;
}

export interface PatchResponse {
  model_id: string;
  tokens: string[];
  n_layers: number;
  seq_len: number;
  answer: string;
  corrupted_answer: string;
  clean_logit_diff: number;
  corrupted_logit_diff: number;
  /** grid[layer][position] = patch score (0 = no effect, 1 = restores clean answer). */
  grid: number[][];
  stub: boolean;
  note?: string | null;
}

export async function patchActivations(req: PatchRequest): Promise<PatchResponse> {
  return miFetch<PatchResponse>('/probe/patch', {
    method: 'POST',
    body: req,
  });
}

// ---------- Direct logit attribution (Intervene) ----------

export interface AttributionRequest {
  model_id: string;
  prompt: string;
  answer: string; // token_a — pushes that score "warm"
  corrupted_answer: string; // token_b — pushes that score "cool"
}

export interface ComponentEffect {
  layer: number;
  /** -1 means the layer's MLP, otherwise an attention head index. */
  head: number;
  /** signed: + toward answer, - toward corrupted_answer. */
  effect: number;
}

export interface AttributionResponse {
  model_id: string;
  n_layers: number;
  n_heads: number;
  answer: string;
  corrupted_answer: string;
  logit_diff: number;
  /** head_grid[layer][head] = signed direct contribution to the logit-diff. */
  head_grid: number[][];
  /** mlp[layer] = signed direct contribution of that layer's MLP. */
  mlp: number[];
  top_contributors: ComponentEffect[];
  stub: boolean;
  note?: string | null;
}

export async function logitAttribution(req: AttributionRequest): Promise<AttributionResponse> {
  return miFetch<AttributionResponse>('/probe/logit_attribution', {
    method: 'POST',
    body: req,
  });
}

// ---------- Next-token prediction (fill the contrast pair) ----------

export interface NextTokensRequest {
  model_id: string;
  prompt: string;
  top_k?: number;
}

export interface NextTokensResponse {
  model_id: string;
  prompt: string;
  top_tokens: TopToken[];
  stub: boolean;
  note?: string | null;
}

export async function nextTokens(req: NextTokensRequest): Promise<NextTokensResponse> {
  return miFetch<NextTokensResponse>('/probe/next_tokens', {
    method: 'POST',
    body: req,
  });
}

// ---------- Instrument canary (self-test) ----------

export interface CanaryCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CanaryResponse {
  model_id: string;
  verdict: 'verified' | 'suspect' | 'unknown';
  checks: CanaryCheck[];
  stub: boolean;
  note?: string | null;
}

export async function runCanary(modelId: string): Promise<CanaryResponse> {
  return miFetch<CanaryResponse>('/probe/canary', {
    method: 'POST',
    body: { model_id: modelId },
  });
}

// ---------- Neuron activations (Features) ----------

export interface NeuronFiring {
  position: number;
  token: string;
  neuron: number;
  activation: number;
}

export interface NeuronFiringsResponse {
  model_id: string;
  layer: number;
  d_mlp: number;
  firings: NeuronFiring[];
  stub: boolean;
  note?: string | null;
}

export async function getNeurons(req: {
  model_id: string;
  prompt: string;
  layer: number;
  top_k?: number;
}): Promise<NeuronFiringsResponse> {
  return miFetch<NeuronFiringsResponse>('/probe/neurons', { method: 'POST', body: req });
}

// ---------- J-lens workspace readout (Inspect) ----------
// The ~/jlens Jacobian-lens engine as a workbench probe (intake pull #2).

export interface JlensResponse {
  model_id: string;
  prompt: string;
  tokens: string[];
  layers: number[];
  layer_pct: number[];
  /** grid[layer][pos] = top-k [token, prob] — what's poised in the workspace. */
  grid: Record<string, [string, number][][]>;
  argmax: Record<string, string[]>;
  j_cached: boolean;
  j_seconds: number;
  stub: boolean;
  note?: string | null;
}

export async function getJlens(req: {
  model_id: string;
  prompt: string;
  top_k?: number;
}): Promise<JlensResponse> {
  return miFetch<JlensResponse>('/probe/jlens', { method: 'POST', body: req });
}

// ---------- surprisal / unit activation / generation trace ----------

export interface TokenSurprisal {
  token: string;
  /** -log2 p(token | context), bits. 0 for the first token (no context). */
  surprisal: number;
  prob: number;
  entropy: number;
  expected: TopToken[];
}

export interface SurprisalResponse {
  model_id: string;
  tokens: TokenSurprisal[];
  mean_surprisal: number;
  stub: boolean;
  note?: string | null;
}

export async function getSurprisal(req: {
  model_id: string;
  prompt: string;
}): Promise<SurprisalResponse> {
  return miFetch<SurprisalResponse>('/probe/surprisal', { method: 'POST', body: req });
}

export interface UnitActivationResponse {
  model_id: string;
  layer: number;
  unit: number;
  tokens: string[];
  activations: number[];
  stub: boolean;
  note?: string | null;
}

export async function getUnitActivation(req: {
  model_id: string;
  prompt: string;
  layer: number;
  unit: number;
}): Promise<UnitActivationResponse> {
  return miFetch<UnitActivationResponse>('/probe/unit_activation', { method: 'POST', body: req });
}

export interface GenerationStep {
  token: string;
  prob: number;
  entropy: number;
  candidates: TopToken[];
}

export interface GenerateTraceResponse {
  model_id: string;
  prompt: string;
  completion: string;
  temperature: number;
  steps: GenerationStep[];
  stub: boolean;
  note?: string | null;
}

export async function getGenerateTrace(req: {
  model_id: string;
  prompt: string;
  max_new_tokens?: number;
  temperature?: number;
  top_k?: number;
}): Promise<GenerateTraceResponse> {
  return miFetch<GenerateTraceResponse>('/probe/generate_trace', { method: 'POST', body: req });
}

// ---------- saliency / weight lens ----------

export interface SaliencyResponse {
  model_id: string;
  tokens: string[];
  /** Gradient L2 norm per token: sensitivity of the target logit. */
  saliency: number[];
  target: string;
  stub: boolean;
  note?: string | null;
}

export async function getSaliency(req: {
  model_id: string;
  prompt: string;
  answer?: string;
}): Promise<SaliencyResponse> {
  return miFetch<SaliencyResponse>('/probe/saliency', { method: 'POST', body: req });
}

export interface WeightLensResponse {
  model_id: string;
  layer: number;
  unit: number;
  reads: TopToken[];
  promotes: TopToken[];
  suppresses: TopToken[];
  stub: boolean;
  note?: string | null;
}

export async function getWeightLens(req: {
  model_id: string;
  layer: number;
  unit: number;
  top_k?: number;
}): Promise<WeightLensResponse> {
  return miFetch<WeightLensResponse>('/probe/weight_lens', { method: 'POST', body: req });
}

// ---------- max-activating examples / model diff ----------

export interface MaxActivatingExample {
  text: string;
  tokens: string[];
  activations: number[];
  max_value: number;
  max_token: string;
}

export interface MaxActivatingResponse {
  model_id: string;
  layer: number;
  unit: number;
  examples: MaxActivatingExample[];
  corpus_size: number;
  stub: boolean;
  note?: string | null;
}

export async function getMaxActivating(req: {
  model_id: string;
  layer: number;
  unit: number;
  top_k?: number;
}): Promise<MaxActivatingResponse> {
  return miFetch<MaxActivatingResponse>('/probe/max_activating', { method: 'POST', body: req });
}

export interface ModelDiffResponse {
  model_id: string;
  model_b: string;
  tokens: string[];
  surprisal_a: number[];
  surprisal_b: number[];
  top_a: TopToken[];
  top_b: TopToken[];
  stub: boolean;
  note?: string | null;
}

export async function getModelDiff(req: {
  model_id: string;
  model_b?: string;
  prompt: string;
  top_k?: number;
}): Promise<ModelDiffResponse> {
  return miFetch<ModelDiffResponse>('/probe/model_diff', { method: 'POST', body: req });
}

// ---------- tokenizer inspector / head census ----------

export interface TokenInfo {
  token: string;
  id: number;
  n_bytes: number;
}

export interface TokenizeResponse {
  model_id: string;
  tokens: TokenInfo[];
  n_tokens: number;
  space_lesson?: string | null;
  stub: boolean;
  note?: string | null;
}

export async function getTokenize(req: {
  model_id: string;
  prompt: string;
}): Promise<TokenizeResponse> {
  return miFetch<TokenizeResponse>('/probe/tokenize', { method: 'POST', body: req });
}

export interface CensusHead {
  layer: number;
  head: number;
  score: number;
}

export interface HeadCensusResponse {
  model_id: string;
  n_layers: number;
  n_heads: number;
  prev_token: number[][];
  induction: number[][];
  sink: number[][];
  top: Record<string, CensusHead[]>;
  stub: boolean;
  note?: string | null;
}

export async function getHeadCensus(modelId: string): Promise<HeadCensusResponse> {
  return miFetch<HeadCensusResponse>('/probe/head_census', {
    method: 'POST',
    body: { model_id: modelId },
  });
}

// ---------- J-lens paper tools: pinned ranks, swap, layer regimes ----------

export async function getJlensReady(modelId: string): Promise<{ model_id: string; warm: boolean }> {
  return miFetch<{ model_id: string; warm: boolean }>('/probe/jlens_ready', {
    method: 'POST',
    body: { model_id: modelId },
  });
}

export interface JlensPinnedResponse {
  model_id: string;
  tokens: string[];
  layers: number[];
  layer_pct: number[];
  /** ranks[token][layer_idx][pos] = rank in the lens (1 = top). */
  ranks: Record<string, number[][]>;
  stub: boolean;
  note?: string | null;
}

export async function getJlensPinned(req: {
  model_id: string;
  prompt: string;
  pinned: string[];
}): Promise<JlensPinnedResponse> {
  return miFetch<JlensPinnedResponse>('/probe/jlens_pinned', { method: 'POST', body: req });
}

export interface JlensSwapResponse {
  model_id: string;
  source: string;
  target: string;
  band_pct: number[];
  clean: string;
  swapped: string;
  stub: boolean;
  note?: string | null;
}

export async function jlensSwap(req: {
  model_id: string;
  prompt: string;
  source: string;
  target: string;
  alpha?: number;
  max_new_tokens?: number;
}): Promise<JlensSwapResponse> {
  return miFetch<JlensSwapResponse>('/probe/jlens_swap', { method: 'POST', body: req });
}

export interface JlensStatsResponse {
  model_id: string;
  layers: number[];
  layer_pct: number[];
  kurtosis: number[];
  output_agreement: number[];
  stub: boolean;
  note?: string | null;
}

export async function getJlensStats(modelId: string): Promise<JlensStatsResponse> {
  return miFetch<JlensStatsResponse>('/probe/jlens_stats', {
    method: 'POST',
    body: { model_id: modelId },
  });
}

// ---------- Concept direction (Features) ----------
// belief-lab's contrast probe ported onto the model's own residual stream —
// the jlens+belief-lab fusion from MI_WORKBENCH_INTAKE.md.

export interface ConceptDirectionResponse {
  model_id: string;
  n_layers: number;
  /** scores[layer] = centered cosine of the test prompt with the pos−neg axis. */
  scores: number[];
  best_layer: number;
  best_score: number;
  stub: boolean;
  note?: string | null;
}

export async function getConceptDirection(req: {
  model_id: string;
  prompt: string;
  pos_prompts: string[];
  neg_prompts: string[];
}): Promise<ConceptDirectionResponse> {
  return miFetch<ConceptDirectionResponse>('/probe/concept_direction', {
    method: 'POST',
    body: req,
  });
}

// ---------- Health ----------

export interface HealthResponse {
  status: string;
}

export async function getHealth(): Promise<HealthResponse> {
  return miFetch<HealthResponse>('/health/live');
}
