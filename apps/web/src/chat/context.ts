// Outgoing-context helpers for the Chat page: label who-said-what across
// providers, and compress extremely long histories so they never blow a
// model's context window. Pure functions only — the actual summarize call
// (which needs a provider) lives in ChatPage.
//
// The stored transcript is ALWAYS kept in full; compression only trims what
// is SENT per request. Thresholds are deliberately generous — long chats
// stay verbatim; summarization is a last resort for genuinely huge ones.

import { humanModel } from '../frontier/providers.js';
import type { ConversationEntry } from './types.js';

/** ~4 chars/token, so 240k chars ≈ 60k tokens before compression starts. */
export const CONTEXT_CHAR_BUDGET = 240_000;
/** Recent messages always sent verbatim (past any summary). */
export const KEEP_RECENT = 20;
/** Re-summarize once this many new messages accrue past the last summary. */
export const SUMMARY_REFRESH_GAP = 16;

export interface OutgoingMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Coarse provider identity of an assistant turn (for "is this cross-provider"). */
export function entryProviderKey(entry: ConversationEntry): string | null {
  if (entry.frontierMeta) return entry.frontierMeta.provider;
  if (entry.meta) return 'platform';
  return null;
}

/** Human label of who produced an assistant turn, e.g. "Anthropic Sonnet 5". */
export function entrySourceLabel(entry: ConversationEntry): string | null {
  if (entry.frontierMeta) {
    return `${entry.frontierMeta.provider} ${humanModel(entry.frontierMeta.model)}`;
  }
  if (entry.meta) return `Platform · ${entry.meta.model}`;
  return null;
}

/** Prefix an assistant turn with its source when it differs from the model
 *  now answering, so a provider knows which of the prior turns weren't its
 *  own. Same-provider turns (and user turns) are left clean. */
export function labeledContent(entry: ConversationEntry, currentKey: string): string {
  if (entry.role !== 'assistant') return entry.content;
  const key = entryProviderKey(entry);
  if (key && key !== currentKey) {
    const label = entrySourceLabel(entry);
    if (label) return `[${label}] ${entry.content}`;
  }
  return entry.content;
}

export function estimateChars(entries: ConversationEntry[]): number {
  let total = 0;
  for (const e of entries) total += e.content.length + 8; // +role/framing overhead
  return total;
}

/** Cutoff index for the "recent window": at most `keepRecent` from the end,
 *  snapped back to a user-role boundary so a prepended summary rides on a
 *  user message (keeps user/assistant alternation valid for all providers). */
export function userBoundaryCutoff(full: ConversationEntry[], keepRecent: number): number {
  let cutoff = Math.max(0, full.length - keepRecent);
  while (cutoff > 0 && full[cutoff]?.role !== 'user') cutoff--;
  return cutoff;
}

export function summarizePrompt(prior: string | undefined, turns: ConversationEntry[]): string {
  const rendered = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');
  const head = prior ? `Existing summary of the earlier conversation:\n${prior}\n\n` : '';
  return (
    `${head}Update the running summary to include the additional conversation below. ` +
    `Stay concise but preserve key facts, decisions, names, numbers, and open questions. ` +
    `Return only the summary text.\n\n${rendered}`
  );
}
