/**
 * Reference resolution for AI responses — F-0 Criterion 5 per ADR-0037.
 *
 * Before generation, identify what references inform THIS specific
 * response:
 *   - Project context (what the user is working on)
 *   - Recent decisions (the canvas-save reasoning-capture records)
 *   - Recent chain history (architecture + project lifecycle activity)
 *   - Session context (conversation so far — stays empty for F-0)
 *
 * Per ADR-0037 (F-0 Criteria 5+7): the resolver loads SELECTIVELY,
 * not exhaustively. A colleague who's been in the room brings up
 * what's relevant; the resolver does the same. Selection is recency
 * + (cheap) keyword relevance on the user's question.
 *
 * The references constrain AND elevate generation simultaneously.
 * Generic responses come from no grounding. Grounded responses come
 * from the user's actual project state.
 */

import type pg from 'pg';
import {
  architectureCompositionChainId,
  computeEventHash,
  userPrimaryChainId,
  type LedgerHandle,
} from '@epagoge/ledger';
import { decodeCbor } from '@epagoge/shared';

export interface ResponseReferences {
  projectContext: ProjectContext | null;
  recentDecisions: DecisionRecord[];
  chainHistory: ChainEventSummary[];
  sessionContext: SessionEntry[];
}

export interface ProjectContext {
  projectId: string;
  projectName: string;
  lifecyclePosition: 'data' | 'architecture' | 'training' | 'evaluation' | 'deployment' | null;
  purpose: string | null;
  recentActivity: string[];
}

export interface DecisionRecord {
  decisionId: string;
  summary: string;
  reasoning: string;
  timestamp: string;
}

export interface ChainEventSummary {
  eventHash: string;
  chainId: string;
  eventType: string;
  summary: string;
}

export interface SessionEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ResolveReferencesParams {
  userId: string;
  projectId: string | null;
  sessionId: string;
  query: string;
  pool: pg.Pool;
  ledger: LedgerHandle;
}

/**
 * Per-section caps. The total grounding context aims for ~1.5KB of
 * text — enough for the AI to ground in specifics without crowding
 * out the actual user message.
 */
const MAX_DECISIONS = 5;
const MAX_CHAIN_EVENTS = 6;
const MAX_PROJECT_ACTIVITY = 4;

/**
 * Resolve references for a given query in given context.
 *
 * Selectivity matters: passing everything bloats tokens and dilutes
 * signal. Passing nothing produces generic responses. The resolver
 * selects by recency, capped per section, with cheap keyword
 * highlighting where the query mentions specific terms.
 */
export async function resolveReferences(
  params: ResolveReferencesParams,
): Promise<ResponseReferences> {
  const { userId, projectId, sessionId, query, pool, ledger } = params;

  const projectContext = projectId
    ? await loadProjectContext(projectId, userId, pool, ledger)
    : null;
  const recentDecisions = await loadRecentDecisions(userId, projectId, query, pool, ledger);
  const chainHistory = await loadChainHistory(userId, projectId, ledger);
  const sessionContext = await loadSessionContext(sessionId, pool);

  return {
    projectContext,
    recentDecisions,
    chainHistory,
    sessionContext,
  };
}

/**
 * Format references for inclusion in a system prompt.
 *
 * The format matters: too verbose and tokens explode; too terse and the
 * model can't actually use it. The middle ground gives the model what
 * it needs to ground responses without bloating context.
 */
export function formatReferencesForPrompt(refs: ResponseReferences): string {
  const sections: string[] = [];

  if (refs.projectContext) {
    const pc = refs.projectContext;
    const lines = [
      `PROJECT CONTEXT:`,
      `Working on: ${pc.projectName}`,
      `Current focus: ${pc.lifecyclePosition ?? 'undefined'}`,
    ];
    if (pc.purpose) lines.push(`Purpose: ${pc.purpose}`);
    if (pc.recentActivity.length > 0) {
      lines.push(`Recent activity:`);
      for (const a of pc.recentActivity) lines.push(`  - ${a}`);
    }
    sections.push(lines.join('\n'));
  }

  if (refs.recentDecisions.length > 0) {
    sections.push(
      `RELEVANT RECENT DECISIONS:\n${refs.recentDecisions
        .map((d) => `- ${d.summary} (${d.timestamp})\n  ${d.reasoning}`)
        .join('\n')}`,
    );
  }

  if (refs.chainHistory.length > 0) {
    sections.push(
      `RECENT CHAIN HISTORY:\n${refs.chainHistory
        .map((e) => `- ${e.eventType}: ${e.summary}`)
        .join('\n')}`,
    );
  }

  if (refs.sessionContext.length > 0) {
    sections.push(
      `SESSION CONTEXT:\n${refs.sessionContext.map((e) => `[${e.role}] ${e.content}`).join('\n')}`,
    );
  }

  return sections.length > 0
    ? `\n---\nREFERENCES FOR THIS RESPONSE:\n\n${sections.join('\n\n')}\n---\n`
    : '';
}

// ---------- Implementations (F-0 Criterion 5) ----------

async function loadProjectContext(
  projectId: string,
  userId: string,
  pool: pg.Pool,
  ledger: LedgerHandle,
): Promise<ProjectContext | null> {
  // Project row — name, description, lifecycle position. Constrained
  // to projects owned by the asking user so we never leak cross-user
  // context into AI grounding.
  const projectRow = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    lifecycle_position: string;
  }>(
    `SELECT id, name, description, lifecycle_position
       FROM projects
      WHERE id = $1 AND owner_user_id = $2
      LIMIT 1`,
    [projectId, userId],
  );
  if (projectRow.rowCount === 0) return null;
  const row = projectRow.rows[0]!;

  // Recent activity: last few architecture saves for this project,
  // rendered as one-liners. Walks the user's architecture-composition
  // chain backward from head and filters by project_id in payload.
  const recentActivity = await collectRecentArchitectureActivity(
    userId,
    projectId,
    ledger,
    MAX_PROJECT_ACTIVITY,
  );

  return {
    projectId: row.id,
    projectName: row.name,
    lifecyclePosition: row.lifecycle_position as ProjectContext['lifecyclePosition'],
    purpose: row.description,
    recentActivity,
  };
}

async function loadRecentDecisions(
  userId: string,
  projectId: string | null,
  query: string,
  _pool: pg.Pool,
  ledger: LedgerHandle,
): Promise<DecisionRecord[]> {
  // The user's canvas saves produce reasoning-capture records (per
  // E2-1). For F-0 we surface them as the "decisions" feed — they
  // already carry a decision_summary and reasoning text. When a
  // projectId is set we filter to its architectures only.
  //
  // The cheap relevance hook: if the query mentions specific
  // component terms (attention, embedding, dropout, etc.) we
  // promote decisions whose summary contains the term. Otherwise
  // recency-only.
  const archHead = await ledger.getChainHead(architectureCompositionChainId(userId), 'local_user');
  if (!archHead) return [];

  const matches: DecisionRecord[] = [];
  const queryTerms = extractQueryTerms(query);

  // Walk backward from head, decode payloads, filter by project (if any).
  let walked = 0;
  for await (const event of ledger.walkPredecessors(archHead.headHash, { maxDepth: 40 })) {
    if (walked++ > 40) break;
    if (event.chain_id !== architectureCompositionChainId(userId)) continue;
    const payload = await safeDecodePayload(ledger, event);
    if (!payload) continue;
    if (projectId !== null && payload.project_id !== projectId) continue;
    if (projectId === null && payload.project_id !== undefined) {
      // When the caller has no active project, prefer pre-F-0 orphan
      // saves so we don't bleed cross-project context into the AI.
      continue;
    }
    const summary = `Canvas save: "${payload.name}" (${payload.nodes?.length ?? 0} nodes, ${payload.edges?.length ?? 0} edges)`;
    const reasoning =
      typeof payload.description === 'string' && payload.description.trim().length > 0
        ? payload.description.trim()
        : `Committed graph state at occurred_at=${payload.occurred_at}`;
    const decisionRecord: DecisionRecord = {
      decisionId: `CANVAS-${(payload.architecture_id as string).slice(0, 8)}-${userId.slice(0, 8)}-${event.causal_sequence_marker}`,
      summary,
      reasoning,
      timestamp: payload.occurred_at ?? '',
    };
    matches.push(decisionRecord);
    if (matches.length >= MAX_DECISIONS * 2) break; // collect extra for ranking
  }

  // Promote query-relevant matches to the top; recency tiebreak.
  matches.sort((a, b) => {
    const aRel = relevanceScore(a.summary + ' ' + a.reasoning, queryTerms);
    const bRel = relevanceScore(b.summary + ' ' + b.reasoning, queryTerms);
    if (aRel !== bRel) return bRel - aRel;
    return b.timestamp.localeCompare(a.timestamp);
  });
  return matches.slice(0, MAX_DECISIONS);
}

async function loadChainHistory(
  userId: string,
  projectId: string | null,
  ledger: LedgerHandle,
): Promise<ChainEventSummary[]> {
  // Breadth context: the last few project-lifecycle events on the
  // user-primary chain. When a project is selected, filter to that
  // project's events.
  const userHead = await ledger.getChainHead(userPrimaryChainId(userId), 'local_user');
  if (!userHead) return [];

  const summaries: ChainEventSummary[] = [];
  let walked = 0;
  for await (const event of ledger.walkPredecessors(userHead.headHash, { maxDepth: 30 })) {
    if (walked++ > 30) break;
    if (event.chain_id !== userPrimaryChainId(userId)) continue;
    const payload = await safeDecodePayload(ledger, event);
    if (!payload) continue;
    if (projectId !== null && 'project_id' in payload && payload.project_id !== projectId) continue;
    const summary = summarizeUserPrimaryEvent(payload);
    if (summary === null) continue;
    summaries.push({
      eventHash: event.payload_integrity ?? '',
      chainId: event.chain_id,
      eventType: event.event_type,
      summary,
    });
    if (summaries.length >= MAX_CHAIN_EVENTS) break;
  }
  return summaries;
}

async function loadSessionContext(_sessionId: string, _pool: pg.Pool): Promise<SessionEntry[]> {
  // Multi-turn chat persistence ships in Phase 1 (ai_sessions table).
  // For F-0 the session is the conversation array the caller already
  // passes — no server-side state to fetch.
  return [];
}

// ---------- Helpers ----------

async function collectRecentArchitectureActivity(
  userId: string,
  projectId: string,
  ledger: LedgerHandle,
  cap: number,
): Promise<string[]> {
  const archHead = await ledger.getChainHead(architectureCompositionChainId(userId), 'local_user');
  if (!archHead) return [];
  const out: string[] = [];
  let walked = 0;
  for await (const event of ledger.walkPredecessors(archHead.headHash, { maxDepth: 30 })) {
    if (walked++ > 30) break;
    if (event.chain_id !== architectureCompositionChainId(userId)) continue;
    const payload = await safeDecodePayload(ledger, event);
    if (!payload) continue;
    if (payload.project_id !== projectId) continue;
    const nodes = Array.isArray(payload.nodes) ? payload.nodes.length : 0;
    const edges = Array.isArray(payload.edges) ? payload.edges.length : 0;
    out.push(`Saved "${payload.name}" — ${nodes} nodes, ${edges} edges`);
    if (out.length >= cap) break;
  }
  return out;
}

function summarizeUserPrimaryEvent(payload: PayloadShape): string | null {
  if (payload.kind === 'project-created') {
    return `Created project "${payload.name}" at lifecycle=${payload.lifecycle_position}`;
  }
  if (payload.kind === 'project-lifecycle-updated') {
    return `Moved project ${(payload.project_id as string).slice(0, 8)}… from ${payload.previous_position} to ${payload.new_position}`;
  }
  // Genesis or unknown — skip rather than reciting opaque content.
  return null;
}

type PayloadShape = Record<string, unknown> & {
  kind?: string;
  name?: string;
  project_id?: string;
  lifecycle_position?: string;
  previous_position?: string;
  new_position?: string;
  description?: string;
  occurred_at?: string;
  architecture_id?: string;
  nodes?: unknown[];
  edges?: unknown[];
};

async function safeDecodePayload(
  ledger: LedgerHandle,
  event: Parameters<typeof computeEventHash>[0],
): Promise<PayloadShape | null> {
  try {
    // walkPredecessors yields AttestedEvent objects (without hash);
    // recompute the canonical event hash so we can look up the
    // payload bytes via the ledger's blob/inline layer.
    const eventHash = computeEventHash(event);
    const bytes = await ledger.getEventPayload(eventHash);
    if (!bytes) return null;
    const decoded = decodeCbor(bytes);
    if (decoded && typeof decoded === 'object') return decoded as PayloadShape;
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract content words from the user's query for cheap relevance
 * scoring. Lowercased, deduplicated, stopwords removed. The simplest
 * thing that could possibly work — and per ADR-0037 that's the right
 * F-0 scope; richer semantic relevance is Phase 1 territory.
 */
function extractQueryTerms(query: string): readonly string[] {
  const STOPWORDS = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'this',
    'that',
    'i',
    'you',
    'we',
    'should',
    'would',
    'could',
    'do',
    'does',
    'how',
    'what',
    'why',
    'when',
    'which',
    'me',
    'my',
    'your',
    'it',
    'its',
  ]);
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  );
}

function relevanceScore(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (lower.includes(t)) hits++;
  return hits;
}
