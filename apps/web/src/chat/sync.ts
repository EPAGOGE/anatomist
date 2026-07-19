// Server sync for chat sessions. The persisted localStorage store (./store)
// stays the fast, offline-capable cache; this layer mirrors it to the api
// (per-user Postgres) so conversations are durable and — when the platform
// is hosted — available across devices.
//
// Model: the server is the source of truth. On login we hydrate from it and
// reconcile; thereafter every content change is written through (debounced).
// If the server is unreachable, everything keeps working locally and syncs
// on the next successful hydrate. Empty (message-less) sessions are never
// pushed, so the server isn't cluttered with blank "New chat" rows.

import { useChatStore } from './store.js';
import { listChatSessions, putChatSession, deleteChatSession } from '../api/endpoints.js';
import type { ChatSession } from './types.js';

const PUSH_DEBOUNCE_MS = 700;

let unsubscribe: (() => void) | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSynced = new Map<string, number>(); // session id -> updatedAt last pushed
let running = false;

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void pushDirty();
  }, PUSH_DEBOUNCE_MS);
}

async function pushDirty(): Promise<void> {
  const sessions = useChatStore.getState().sessions;
  const currentIds = new Set(sessions.map((s) => s.id));

  // Push created/updated sessions that carry content.
  for (const s of sessions) {
    if (s.entries.length === 0) continue; // don't persist blank sessions
    const prev = lastSynced.get(s.id);
    if (prev !== undefined && prev >= s.updatedAt) continue; // unchanged since last push
    try {
      await putChatSession({ id: s.id, title: s.title, entries: s.entries });
      lastSynced.set(s.id, s.updatedAt);
    } catch {
      // Leave it dirty; the next change (or hydrate) retries.
    }
  }

  // Delete sessions removed locally that were previously synced.
  for (const id of [...lastSynced.keys()]) {
    if (currentIds.has(id)) continue;
    try {
      await deleteChatSession(id);
      lastSynced.delete(id);
    } catch {
      // Retry on the next push.
    }
  }
}

function reconcile(serverSessions: ChatSession[]): void {
  const store = useChatStore.getState();
  const serverIds = new Set(serverSessions.map((s) => s.id));
  // Keep local sessions that have content the server hasn't seen (e.g. created
  // while offline) so they aren't lost; blank/local-only sessions are dropped.
  const localOnlyWithContent = store.sessions.filter(
    (s) => !serverIds.has(s.id) && s.entries.length > 0,
  );
  const merged = [...serverSessions, ...localOnlyWithContent];
  if (merged.length === 0) return; // nothing anywhere — keep the fresh local session

  const activeStillPresent = merged.some((s) => s.id === store.activeId);
  const newest = [...merged].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
  useChatStore.setState({
    sessions: merged,
    activeId: activeStillPresent ? store.activeId : newest.id,
  });
}

/** Begin syncing the chat store with the server (idempotent). Local-first:
 *  no auth gate. Safe to call on every Chat page mount. */
export async function startChatSync(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const { sessions } = await listChatSessions();
    reconcile(sessions);
    for (const s of sessions) lastSynced.set(s.id, s.updatedAt);
  } catch {
    // Server unreachable — keep the local cache; a later mount will retry.
  }

  unsubscribe = useChatStore.subscribe(schedulePush);
  // Push anything local-only-with-content surfaced by reconcile.
  schedulePush();
}

/** Stop syncing (flushes a final push). Called on Chat page unmount. */
export function stopChatSync(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (running) void pushDirty(); // best-effort flush of pending changes
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  running = false;
}

/** Forget everything this sync layer knows — called on logout so a different
 *  user on the same browser never inherits the previous user's cached chats. */
export function resetChatSync(): void {
  stopChatSync();
  lastSynced = new Map();
}
