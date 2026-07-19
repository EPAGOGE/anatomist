// Shared shapes for the Chat page and its persisted session store.

import type { ChatResponse } from '../api/endpoints.js';

/** Provider + model tag for a reply that came from a user-connected frontier. */
export interface FrontierMeta {
  provider: string;
  model: string;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  // Assistant entries carry EITHER platform routing metadata (built-in chat)…
  meta?: ChatResponse;
  // …or the provider/model when answered by a user-connected frontier.
  frontierMeta?: FrontierMeta;
}

/** One saved conversation thread. */
export interface ChatSession {
  id: string;
  title: string;
  entries: ConversationEntry[];
  createdAt: number;
  updatedAt: number;
  // Client-side context cache (never sent to the server): a running summary
  // of entries[0..summaryThrough) used to compress very long histories before
  // sending to a model. The full transcript is always kept in `entries`.
  summary?: string;
  summaryThrough?: number;
}
