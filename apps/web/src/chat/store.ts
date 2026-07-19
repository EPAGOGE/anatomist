// Persisted chat sessions. Conversations are saved to localStorage (this
// browser) so they rehydrate onto the screen across reloads and logins —
// same storage approach as the auth and frontier stores.
//
// Multiple named sessions ("per session"): switch between them, start new
// ones, delete old ones. The active session's entries drive the Chat page.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatSession, ConversationEntry } from './types.js';

const TITLE_MAX = 40;
/** Keep localStorage bounded — drop the oldest sessions past this count. */
const MAX_SESSIONS = 50;

function titleFrom(content: string): string {
  const t = content.trim().replace(/\s+/g, ' ');
  if (!t) return 'New chat';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

function makeSession(): ChatSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
}

interface ChatStore {
  sessions: ChatSession[];
  activeId: string;
  newChat: () => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  /** Append an entry to the active session (auto-titles on the first user msg). */
  appendEntry: (entry: ConversationEntry) => void;
  /** Remove the active session's last entry (optimistic-send rollback). */
  popEntry: () => void;
  /** Cache a running summary covering entries[0..through) of a session. */
  setSummary: (id: string, summary: string, through: number) => void;
  /** Wipe all local sessions (used on logout so users don't share a cache). */
  clearAll: () => void;
}

const first = makeSession();

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      sessions: [first],
      activeId: first.id,

      newChat: () =>
        set((s) => {
          const n = makeSession();
          return { sessions: [n, ...s.sessions].slice(0, MAX_SESSIONS), activeId: n.id };
        }),

      selectChat: (id) => set({ activeId: id }),

      deleteChat: (id) =>
        set((s) => {
          const sessions = s.sessions.filter((x) => x.id !== id);
          if (sessions.length === 0) {
            const n = makeSession();
            return { sessions: [n], activeId: n.id };
          }
          const activeId = s.activeId === id ? sessions[0]!.id : s.activeId;
          return { sessions, activeId };
        }),

      appendEntry: (entry) =>
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== s.activeId) return sess;
            const isFirstUserMsg = sess.entries.length === 0 && entry.role === 'user';
            return {
              ...sess,
              entries: [...sess.entries, entry],
              title: isFirstUserMsg ? titleFrom(entry.content) : sess.title,
              updatedAt: Date.now(),
            };
          }),
        })),

      popEntry: () =>
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === s.activeId ? { ...sess, entries: sess.entries.slice(0, -1) } : sess,
          ),
        })),

      setSummary: (id, summary, through) =>
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === id ? { ...sess, summary, summaryThrough: through } : sess,
          ),
        })),

      clearAll: () => {
        const n = makeSession();
        set({ sessions: [n], activeId: n.id });
      },
    }),
    { name: 'epagoge.chat', version: 1 },
  ),
);
