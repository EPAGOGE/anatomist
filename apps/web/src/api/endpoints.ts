// Typed wrappers for the endpoints the MVP consumes. One function per
// endpoint, return type explicitly stated, no clever generics. When a
// new endpoint joins the MVP, add it here.
//
// Wire shapes verified against a running API on 2026-05-20 — if these
// drift from the server, the breakage will show up at parse time in
// the components, not silently.

import { apiFetch } from './client.js';
// Type-only import (erased at build) — no runtime cycle with chat/types.
import type { ConversationEntry as ChatConversationEntry } from '../chat/types.js';

// ---------- Identity ----------

import type { CurrentUser } from '../auth/store.js';

/** The local owner identity (or token identity when a Bearer is presented). */
export async function getMe(): Promise<{ user: CurrentUser }> {
  return apiFetch<{ user: CurrentUser }>('/me');
}

// ---------- Chains ----------

export interface ChainSummary {
  chain_id: string;
  owner_type: 'platform' | 'user';
  owner_entity_id: string;
  head_hash: string | null;
  event_count: string; // bigint serialized; "0" when chain has no events
}

export interface ChainsListResponse {
  chains: ChainSummary[];
}

export async function listChains(): Promise<ChainsListResponse> {
  return apiFetch<ChainsListResponse>('/chains');
}

export interface ChainDetail {
  chain_id: string;
  owner_type: 'platform' | 'user';
  owner_entity_id: string;
  head_hash: string | null;
  head_sequence_marker: string | null;
  head_source_id: string | null;
  event_count_total: string;
}

export async function getChain(chainId: string): Promise<ChainDetail> {
  return apiFetch<ChainDetail>(`/chains/${encodeURIComponent(chainId)}`);
}

export interface ChainEvent {
  event_hash: string;
  chain_id: string;
  event_type: string;
  source_id: string;
  causal_sequence_marker: string;
  source_reliability: number;
  payload_integrity: string;
  causal_predecessors: string[];
}

export interface ChainEventsResponse {
  chain_id: string;
  events: ChainEvent[];
  since_marker?: string;
  count_since?: number;
}

export async function listChainEvents(
  chainId: string,
  options: { limit?: number; since?: string } = {},
): Promise<ChainEventsResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.since) params.set('since', options.since);
  const qs = params.toString();
  return apiFetch<ChainEventsResponse>(
    `/chains/${encodeURIComponent(chainId)}/events${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Single-event detail. The chain stores CBOR-encoded payloads; when
 * `include_payload=true` the API base64-encodes the raw bytes so they
 * survive JSON transport. Decoding CBOR happens client-side in the
 * component that wants the structured view.
 */
export interface EventDetailResponse {
  event_hash: string;
  chain_id: string;
  event_type: string;
  source_id: string;
  version: number;
  causal_sequence_marker: string;
  causal_predecessors: string[];
  source_reliability: number;
  payload_integrity: string;
  ground_truth_calibration_indicator?: string;
  payload_size_bytes?: number;
  payload_base64?: string;
}

export async function getEvent(
  eventHash: string,
  options: { includePayload?: boolean } = {},
): Promise<EventDetailResponse> {
  const qs = options.includePayload ? '?include_payload=true' : '';
  return apiFetch<EventDetailResponse>(`/events/${eventHash}${qs}`);
}

// ---------- AI ----------

export interface BudgetResponse {
  period_start: string;
  cap_nanos: string;
  spent_nanos: string;
  remaining_nanos: string;
  warn_at_pct: number;
}

export async function getBudget(): Promise<BudgetResponse> {
  return apiFetch<BudgetResponse>('/ai/budget');
}

export interface CostStatsDailyEntry {
  day: string; // YYYY-MM-DD
  call_count: number;
  total_cost_nanos: string;
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface CostStatsDailyResponse {
  period_start: string;
  group_by: 'day';
  daily: CostStatsDailyEntry[];
}

export async function getCostStatsDaily(): Promise<CostStatsDailyResponse> {
  return apiFetch<CostStatsDailyResponse>('/ai/cost-stats?group_by=day');
}

export interface ChatRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tier?: 'haiku' | 'sonnet' | 'opus';
  thinking?: boolean;
  system?: string;
  purpose?: string;
  feature?: string;
  /** Active project for resolver grounding (F-0 Criterion 5). */
  project_id?: string;
}

export interface ChatResponse {
  interaction_id: string;
  chain_event_hash: string;
  text: string;
  model: string;
  tier: 'haiku' | 'sonnet' | 'opus';
  cost_nanos: string;
  from_cache: boolean;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  finish_reason?: string;
  budget: {
    state: 'allow' | 'warn' | 'block';
    spent_nanos: string;
    cap_nanos: string;
    remaining_nanos?: string;
  };
}

export async function chat(input: ChatRequest): Promise<ChatResponse> {
  return apiFetch<ChatResponse>('/ai/chat', {
    method: 'POST',
    body: input,
  });
}

// ---------- Architecture composition (Phase 0 sub-phase E) ----------

export interface ArchitectureSaveRequest {
  /** Stable across revisions. Omit for first save; server assigns one. */
  architecture_id?: string;
  /** Containing project (F-0 Criterion 1). Optional for pre-F-0 saves. */
  project_id?: string;
  name: string;
  description?: string;
  nodes: Array<{
    id: string;
    componentId: string;
    properties: Record<string, string | number | boolean>;
  }>;
  edges: Array<{
    id: string;
    source: { nodeId: string; portId: string };
    target: { nodeId: string; portId: string };
  }>;
}

export interface ArchitectureSaveResponse {
  event_hash: string;
  architecture_id: string;
  name: string;
  node_count: number;
  edge_count: number;
  occurred_at: string;
  /** Companion reasoning-capture event hash (cross-chain ref). */
  reasoning_event_hash: string;
}

export interface ArchitectureSummary {
  event_hash: string;
  causal_sequence_marker: string;
  architecture_id: string | null;
  name: string;
  description: string | null;
  node_count: number;
  edge_count: number;
  occurred_at: string | null;
}

export interface ArchitecturesListResponse {
  user_id: string;
  architectures: ArchitectureSummary[];
}

export interface ArchitectureReplayResponse {
  event_hash: string;
  causal_sequence_marker: string;
  payload: {
    kind: 'architecture-saved';
    version: 1;
    architecture_id: string;
    name: string;
    description?: string;
    nodes: ArchitectureSaveRequest['nodes'];
    edges: ArchitectureSaveRequest['edges'];
    occurred_at: string;
  };
}

export async function saveArchitecture(
  input: ArchitectureSaveRequest,
): Promise<ArchitectureSaveResponse> {
  return apiFetch<ArchitectureSaveResponse>('/architectures', {
    method: 'POST',
    body: input,
  });
}

export async function listArchitectures(limit = 50): Promise<ArchitecturesListResponse> {
  return apiFetch<ArchitecturesListResponse>(`/architectures?limit=${limit}`);
}

export async function getArchitecture(eventHash: string): Promise<ArchitectureReplayResponse> {
  return apiFetch<ArchitectureReplayResponse>(`/architectures/${eventHash}`);
}

// ---------- Validation (E5) ----------
//
// Server-side validation is the source of truth for whether an
// architecture is valid (per ADR-0032 tier 1). The frontend runs the
// same validator client-side for snappy feedback; this endpoint
// confirms what the canvas already shows. The `explain-error`
// endpoint is the tier-2 AI-assisted explanation.

export interface ValidationErrorWire {
  /** Same shape as @epagoge/components ValidationError, plus fingerprint. */
  readonly code: string;
  readonly fingerprint: string;
  readonly [k: string]: unknown;
}

export interface ValidateResponse {
  readonly valid: boolean;
  readonly errors: readonly ValidationErrorWire[];
}

export async function validateArchitecture(
  input: Omit<ArchitectureSaveRequest, 'architecture_id'>,
): Promise<ValidateResponse> {
  return apiFetch<ValidateResponse>('/architectures/validate', {
    method: 'POST',
    body: input,
  });
}

export interface ExplainErrorResponse {
  readonly fingerprint: string;
  readonly explanation: string;
  readonly cost_nanos: string;
  readonly from_cache: boolean;
  readonly interaction_id: string;
  readonly ai_chain_event_hash: string;
  readonly tier: 'haiku' | 'sonnet' | 'opus';
}

export async function explainArchitectureError(
  input: Omit<ArchitectureSaveRequest, 'architecture_id'> & { fingerprint: string },
): Promise<ExplainErrorResponse> {
  return apiFetch<ExplainErrorResponse>('/architectures/explain-error', {
    method: 'POST',
    body: input,
  });
}

// ---------- Projects (F-0 Criterion 1) ----------

export type LifecyclePosition = 'data' | 'architecture' | 'training' | 'evaluation' | 'deployment';

export interface Project {
  project_id: string;
  name: string;
  description: string | null;
  lifecycle_position: LifecyclePosition;
  creation_event_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectsListResponse {
  user_id: string;
  projects: Project[];
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  lifecycle_position?: LifecyclePosition;
}

export interface CreateProjectResponse {
  project_id: string;
  name: string;
  description: string | null;
  lifecycle_position: LifecyclePosition;
  creation_event_hash: string;
  occurred_at: string;
}

export async function listProjects(): Promise<ProjectsListResponse> {
  return apiFetch<ProjectsListResponse>('/projects');
}

export async function getProject(projectId: string): Promise<Project> {
  return apiFetch<Project>(`/projects/${projectId}`);
}

export async function createProject(input: CreateProjectRequest): Promise<CreateProjectResponse> {
  return apiFetch<CreateProjectResponse>('/projects', {
    method: 'POST',
    body: input,
  });
}

export interface UpdateLifecycleResponse {
  project_id: string;
  previous_position?: LifecyclePosition;
  new_position?: LifecyclePosition;
  lifecycle_position?: LifecyclePosition;
  lifecycle_event_hash?: string;
  occurred_at?: string;
}

export async function updateProjectLifecycle(
  projectId: string,
  newPosition: LifecyclePosition,
): Promise<UpdateLifecycleResponse> {
  return apiFetch<UpdateLifecycleResponse>(`/projects/${projectId}/lifecycle`, {
    method: 'PATCH',
    body: { new_position: newPosition },
  });
}

export interface CompanionDecisionRow {
  architecture_id: string;
  architecture_event_hash: string;
  name: string;
  description: string | null;
  node_count: number;
  edge_count: number;
  occurred_at: string;
  causal_sequence_marker: string;
}

export interface CompanionResponse {
  project: Project;
  decision_log: CompanionDecisionRow[];
}

export async function getProjectCompanion(projectId: string): Promise<CompanionResponse> {
  return apiFetch<CompanionResponse>(`/projects/${projectId}/companion`);
}

// ---------- Chat session persistence (durable per-user conversations) ----------

export interface ChatSessionDTO {
  id: string;
  title: string;
  entries: ChatConversationEntry[];
  createdAt: number;
  updatedAt: number;
}

export async function listChatSessions(): Promise<{ sessions: ChatSessionDTO[] }> {
  return apiFetch<{ sessions: ChatSessionDTO[] }>('/chat/sessions');
}

export async function putChatSession(input: {
  id: string;
  title: string;
  entries: ChatConversationEntry[];
}): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/chat/sessions/${input.id}`, {
    method: 'PUT',
    body: { title: input.title, entries: input.entries },
  });
}

export async function deleteChatSession(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/chat/sessions/${id}`, { method: 'DELETE' });
}
