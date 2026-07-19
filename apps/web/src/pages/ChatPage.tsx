import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { chat, type ChatResponse } from '../api/endpoints.js';
import type { ApiError } from '../api/client.js';
import { formatNanosAsUsd, truncateHash } from '../util/format.js';
import { useProjectStore } from '../projects/store.js';
import { FrontierPanel } from '../components/chat/FrontierPanel.js';
import { useFrontierStore, type ProviderCreds } from '../frontier/store.js';
import { resolveProvider, humanModel, type FrontierProvider } from '../frontier/providers.js';
import { callFrontier, FrontierError } from '../frontier/client.js';
import { useChatStore } from '../chat/store.js';
import { startChatSync, stopChatSync } from '../chat/sync.js';
import {
  CONTEXT_CHAR_BUDGET,
  KEEP_RECENT,
  SUMMARY_REFRESH_GAP,
  estimateChars,
  labeledContent,
  summarizePrompt,
  userBoundaryCutoff,
  type OutgoingMessage,
} from '../chat/context.js';
import type { ChatSession, ConversationEntry, FrontierMeta } from '../chat/types.js';

type Tier = 'haiku' | 'sonnet' | 'opus';

// Stable empty reference so `entries` doesn't churn when no session is found.
const NO_ENTRIES: ConversationEntry[] = [];

export function ChatPage() {
  const [input, setInput] = useState('');
  const [tier, setTier] = useState<Tier | 'auto'>('auto');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // F-0 Criterion 5: when a project is active, the chat scopes to
  // it so the resolver loads project context as AI grounding.
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);

  // Conversation lives in the persisted chat store, so it survives reloads
  // and logins and re-renders straight onto the screen.
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeId);
  const { newChat, selectChat, deleteChat, appendEntry, popEntry } = useChatStore();
  const entries = sessions.find((s) => s.id === activeId)?.entries ?? NO_ENTRIES;

  // Mirror the persisted chat store to the server (durable, cross-device when
  // hosted). No-op until authenticated; the local cache works regardless.
  useEffect(() => {
    void startChatSync();
    return () => stopChatSync();
  }, []);

  // Auto-follow the newest message: stick to the bottom as replies arrive,
  // unless the user has scrolled up to read history. Track that on scroll…
  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }
  // …follow new/pending messages while stuck to the bottom…
  useEffect(() => {
    if (stickToBottomRef.current) requestAnimationFrame(scrollToBottom);
  }, [entries.length, sending]);
  // …and always jump to the bottom when switching or loading a session.
  useEffect(() => {
    stickToBottomRef.current = true;
    requestAnimationFrame(scrollToBottom);
  }, [activeId]);

  // A connected frontier (own key) takes over routing when marked active.
  const frontierActive = useFrontierStore((s) => {
    const cred = s.creds[s.providerId];
    if (!s.active || !cred) return false;
    const provider = resolveProvider(s.providerId, s.customEndpoints);
    return cred.model.trim() !== '' && (!provider.requiresKey || cred.apiKey.trim() !== '');
  });
  const frontierProviderId = useFrontierStore((s) => s.providerId);
  const frontierModel = useFrontierStore((s) => s.creds[s.providerId]?.model ?? '');
  const frontierCustom = useFrontierStore((s) => s.customEndpoints);

  // Summarize a slice of older turns via the SAME source that's answering, so
  // a frontier chat's content never leaves for the platform (privacy). Frontier
  // uses the user's key; platform uses a cheap tier.
  async function summarize(
    useFrontier: boolean,
    cred: ProviderCreds | undefined,
    provider: FrontierProvider,
    prior: string | undefined,
    turns: ConversationEntry[],
  ): Promise<string> {
    const prompt = summarizePrompt(prior, turns);
    if (useFrontier && cred) {
      return callFrontier(
        { provider, apiKey: cred.apiKey, model: cred.model, baseUrl: cred.baseUrl },
        [{ role: 'user', content: prompt }],
        { proxy: cred.forceProxy, maxTokens: 1500 },
      );
    }
    const r = await chat({ messages: [{ role: 'user', content: prompt }], tier: 'haiku' });
    return r.text;
  }

  // Build the messages to send: always label cross-provider turns; only when a
  // history is enormous, fold the older turns into a cached summary and keep a
  // recent verbatim window, so the model's context window never explodes.
  async function buildOutgoing(
    full: ConversationEntry[],
    currentKey: string,
    useFrontier: boolean,
    cred: ProviderCreds | undefined,
    provider: FrontierProvider,
  ): Promise<OutgoingMessage[]> {
    const label = (e: ConversationEntry): OutgoingMessage => ({
      role: e.role,
      content: labeledContent(e, currentKey),
    });
    if (estimateChars(full) <= CONTEXT_CHAR_BUDGET) return full.map(label);

    const cutoff = userBoundaryCutoff(full, KEEP_RECENT);
    const session = useChatStore.getState().sessions.find((s) => s.id === activeId);
    let summary = session?.summary;
    const through = session?.summaryThrough ?? 0;
    if (cutoff > 0 && (!summary || cutoff - through >= SUMMARY_REFRESH_GAP)) {
      try {
        summary = await summarize(
          useFrontier,
          cred,
          provider,
          summary,
          full.slice(through, cutoff),
        );
        useChatStore.getState().setSummary(activeId, summary, cutoff);
      } catch {
        // Summarize failed — keep any prior summary; the recent window alone
        // still keeps the request within the model's context window.
      }
    }
    const recent = full.slice(cutoff).map(label);
    if (summary && recent.length > 0) {
      recent[0] = {
        ...recent[0]!,
        content: `[Summary of earlier conversation:\n${summary}\n]\n\n${recent[0]!.content}`,
      };
    }
    return recent;
  }

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setError(null);
    const userEntry: ConversationEntry = { role: 'user', content: trimmed };
    const history = [...entries, userEntry];
    appendEntry(userEntry);
    setInput('');
    setSending(true);

    const fs = useFrontierStore.getState();
    const cred = fs.creds[fs.providerId];
    const provider = resolveProvider(fs.providerId, fs.customEndpoints);
    const useFrontier =
      fs.active &&
      !!cred &&
      cred.model.trim() !== '' &&
      (!provider.requiresKey || cred.apiKey.trim() !== '');

    try {
      const currentKey = useFrontier ? provider.label : 'platform';
      const messages = await buildOutgoing(history, currentKey, useFrontier, cred, provider);
      if (useFrontier && cred) {
        const text = await callFrontier(
          { provider, apiKey: cred.apiKey, model: cred.model, baseUrl: cred.baseUrl },
          messages,
          { proxy: cred.forceProxy },
        );
        appendEntry({
          role: 'assistant',
          content: text,
          frontierMeta: { provider: provider.label, model: cred.model },
        });
      } else {
        const result = await chat({
          messages,
          ...(tier !== 'auto' ? { tier } : {}),
          ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
        });
        appendEntry({ role: 'assistant', content: result.text, meta: result });
        // Invalidate cost/budget caches so the Cost page reflects new spend.
        void queryClient.invalidateQueries({ queryKey: ['cost-daily'] });
        void queryClient.invalidateQueries({ queryKey: ['ai-budget'] });
      }
    } catch (err) {
      const message =
        err instanceof FrontierError ? err.message : ((err as ApiError).message ?? 'chat failed');
      setError(message);
      // Roll back the optimistic user entry so they can retry the message.
      popEntry();
      setInput(trimmed);
    } finally {
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+Enter or Ctrl+Enter sends. Plain Enter inserts a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] gap-4">
      <FrontierPanel />

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-lg font-semibold">Chat</h1>
            <p className="mt-1 text-sm text-neutral-500">
              {frontierActive
                ? 'Prompting your connected frontier. Calls go direct, off the platform ledger.'
                : 'Every call lands a signed event on the ai-interaction chain.'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {frontierActive ? (
              <span className="rounded border border-emerald-900/60 bg-emerald-950/30 px-2 py-1 text-emerald-300">
                via {resolveProvider(frontierProviderId, frontierCustom).label} ·{' '}
                {humanModel(frontierModel)}
              </span>
            ) : (
              <>
                <span className="text-neutral-500">Tier</span>
                <TierSelect value={tier} onChange={setTier} />
              </>
            )}
          </div>
        </header>

        <SessionBar
          sessions={sessions}
          activeId={activeId}
          onSelect={selectChat}
          onNew={newChat}
          onDelete={deleteChat}
          hasEntries={entries.length > 0}
        />

        <div
          ref={scrollRef}
          onScroll={onMessagesScroll}
          className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/30 p-4"
        >
          {entries.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-neutral-500">
              <div>Type a message below to start.</div>
              <div className="text-xs text-neutral-600">
                {frontierActive
                  ? 'Cmd/Ctrl + Enter to send. Answered by your connected frontier model.'
                  : 'Cmd/Ctrl + Enter to send. Each response shows the model used, the cost in nanoUSD, and the chain event hash.'}
              </div>
            </div>
          )}
          {entries.map((entry, i) => (
            <Bubble key={i} entry={entry} />
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-400">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                thinking…
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything. Cmd+Enter to send."
            rows={3}
            className="w-full resize-none rounded bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
            <span>
              {frontierActive
                ? `Using your ${resolveProvider(frontierProviderId, frontierCustom).label}`
                : tier === 'auto'
                  ? 'Auto-routed (length + purpose decide model)'
                  : `Forcing ${tier}`}
            </span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || !input.trim()}
              className="rounded bg-neutral-100 px-4 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionBar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  hasEntries,
}: {
  sessions: ChatSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  hasEntries: boolean;
}) {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const showDelete = sessions.length > 1 || hasEntries;
  return (
    <div className="flex items-center gap-2 text-xs">
      <select
        value={activeId}
        onChange={(e) => onSelect(e.target.value)}
        className="max-w-[16rem] rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-200 focus:border-neutral-600 focus:outline-none"
        title="Saved chats"
      >
        {sorted.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onNew}
        className="rounded border border-neutral-800 px-2 py-1 text-neutral-300 transition hover:border-neutral-600 hover:text-neutral-100"
      >
        + New chat
      </button>
      <div className="flex-1" />
      {showDelete && (
        <button
          type="button"
          onClick={() => onDelete(activeId)}
          className="rounded border border-neutral-800 px-2 py-1 text-neutral-500 transition hover:border-red-900/70 hover:text-red-400"
        >
          Delete
        </button>
      )}
    </div>
  );
}

function Bubble({ entry }: { entry: ConversationEntry }) {
  if (entry.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-900">
          {entry.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm whitespace-pre-wrap text-neutral-100">
          {entry.content}
        </div>
        {entry.meta && <ResponseMeta meta={entry.meta} />}
        {entry.frontierMeta && <FrontierMetaRow meta={entry.frontierMeta} />}
      </div>
    </div>
  );
}

function FrontierMetaRow({ meta }: { meta: FrontierMeta }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-neutral-500">
      <Tag tone="emerald">{meta.provider}</Tag>
      <span className="font-mono text-[10px]">{humanModel(meta.model)}</span>
      <span className="text-neutral-600">your key · not billed to platform</span>
    </div>
  );
}

function ResponseMeta({ meta }: { meta: ChatResponse }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-neutral-500">
      <Tag>{meta.model}</Tag>
      <span>{formatNanosAsUsd(meta.cost_nanos, 6)}</span>
      <span>
        {meta.tokens.input}→{meta.tokens.output} tok
      </span>
      {meta.from_cache && <Tag tone="emerald">cache hit</Tag>}
      <Link
        to={`/chains/${encodeURIComponent('ai-interaction')}`}
        className="font-mono text-neutral-600 hover:text-neutral-400"
        title={meta.chain_event_hash}
      >
        ↳ {truncateHash(meta.chain_event_hash)}
      </Link>
      <span className="text-neutral-600">
        budget {formatNanosAsUsd(meta.budget.spent_nanos)} /{' '}
        {formatNanosAsUsd(meta.budget.cap_nanos, 2)}
      </span>
    </div>
  );
}

function Tag({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'emerald';
}) {
  const bg =
    tone === 'emerald'
      ? 'bg-emerald-900/40 text-emerald-300'
      : 'bg-neutral-800/80 text-neutral-300';
  return <span className={`rounded ${bg} px-1.5 py-0.5 font-mono text-[10px]`}>{children}</span>;
}

function TierSelect({
  value,
  onChange,
}: {
  value: Tier | 'auto';
  onChange: (next: Tier | 'auto') => void;
}) {
  const options: Array<{ value: Tier | 'auto'; label: string }> = [
    { value: 'auto', label: 'auto' },
    { value: 'haiku', label: 'haiku' },
    { value: 'sonnet', label: 'sonnet' },
    { value: 'opus', label: 'opus' },
  ];
  return (
    <div className="flex gap-1 rounded border border-neutral-800 bg-neutral-950 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded px-2 py-1 transition ${
            value === opt.value
              ? 'bg-neutral-800 text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-200'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
