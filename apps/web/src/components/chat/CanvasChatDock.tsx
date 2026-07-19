// CanvasChatDock — bottom-docked command/chat bar for the canvas.
//
// The "command bar over a viewport" pattern: Unreal's bottom panel, a DAW's
// transport, Claude Code's input. The canvas stays the big open working area;
// this bar docks to its bottom edge, full width. One line at rest, the
// composer auto-grows while typing and snaps back to one line on submit — so
// the canvas reclaims its space the instant you send. When there are
// messages, a transcript floats up above the composer (collapsible) so the
// conversation never permanently eats the canvas.
//
// Mounted as an absolute overlay inside the canvas <main> so it sits ON the
// canvas. The outer wrapper is pointer-events:none; only the bar + transcript
// capture pointer events, leaving the rest of the canvas fully interactive.
//
// Swappable: layout lives here, transport lives in useChatSocket. Redesign
// this file freely without touching the wiring.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  CaretDown,
  CaretUp,
  CircleNotch,
  Sparkle,
  WarningCircle,
} from '@phosphor-icons/react';
import { getLoadedModels } from '../../api/mi-endpoints.js';
import { useChatSocket, type ChatConnectionStatus, type ChatMessage } from './useChatSocket.js';

const DEFAULT_CHAT_MODEL = 'gemma-2-2b-it';

export function CanvasChatDock() {
  // Target the first loaded model, falling back to the V1 default. The
  // chat retargets automatically when the user loads a different model
  // from the Workbench. retry:false so a missing backend doesn't spam.
  const loadedQuery = useQuery({
    queryKey: ['mi-loaded'],
    queryFn: getLoadedModels,
    retry: false,
    refetchInterval: 5_000,
  });
  const modelId = loadedQuery.data?.loaded?.[0] ?? DEFAULT_CHAT_MODEL;

  const { messages, status, send, clear } = useChatSocket(modelId);
  const [transcriptOpen, setTranscriptOpen] = useState(true);

  const hasMessages = messages.length > 0;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-stretch gap-2 px-4 pb-3">
      {hasMessages && transcriptOpen && (
        <Transcript messages={messages} onClose={() => setTranscriptOpen(false)} onClear={clear} />
      )}

      <div className="pointer-events-auto w-full">
        <Composer
          status={status}
          disabled={status !== 'open'}
          onSend={send}
          placeholder={composerPlaceholder(status, modelId)}
        />
        <StatusStrip
          modelId={modelId}
          status={status}
          messageCount={messages.length}
          transcriptOpen={transcriptOpen}
          onToggleTranscript={() => setTranscriptOpen((v) => !v)}
        />
      </div>
    </div>
  );
}

function composerPlaceholder(status: ChatConnectionStatus, modelId: string): string {
  if (status === 'open')
    return `Ask ${modelId} anything…  (Enter to send · Shift+Enter for newline)`;
  if (status === 'connecting') return 'Connecting to the MI backend…';
  return 'MI backend offline. Start it to chat (apps/mi-backend)';
}

// ---------- Transcript (floats above the composer) --------------------------

function Transcript({
  messages,
  onClose,
  onClear,
}: {
  messages: ChatMessage[];
  onClose: () => void;
  onClear: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="glass pointer-events-auto mx-auto flex max-h-[42vh] w-full flex-col overflow-hidden rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
      <div className="border-line text-dim flex items-center justify-between border-b px-3 py-1.5 text-[10px] uppercase tracking-[0.18em]">
        <span className="flex items-center gap-1.5">
          <Sparkle size={10} weight="duotone" className="text-accent-soft" />
          conversation
        </span>
        <span className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClear}
            className="hover:text-text normal-case tracking-normal transition"
          >
            clear
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Collapse conversation"
            className="hover:text-text transition"
          >
            <CaretDown size={12} weight="bold" />
          </button>
        </span>
      </div>
      <div ref={scrollRef} className="flex flex-col gap-2.5 overflow-y-auto px-3 py-3">
        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="border-accent/30 bg-accent/10 text-text max-w-[78%] rounded-lg border px-3 py-2 text-sm leading-relaxed">
          {message.text}
        </div>
      </div>
    );
  }
  if (message.role === 'model') {
    return (
      <div className="flex justify-start">
        <div className="border-line bg-panel-2 text-text max-w-[78%] rounded-lg border px-3 py-2 text-sm leading-relaxed">
          <div className="text-dim mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.15em]">
            <Sparkle size={9} weight="duotone" className="text-accent-soft" />
            model
            {message.streaming && (
              <CircleNotch size={9} weight="bold" className="text-dim ml-1 animate-spin" />
            )}
          </div>
          {message.text || <span className="text-dim text-xs italic">thinking…</span>}
          {message.error && (
            <div className="border-warn/30 bg-warn/5 text-warn mt-2 flex items-start gap-1.5 rounded border px-2 py-1 text-[11px]">
              <WarningCircle size={11} weight="duotone" className="mt-0.5 shrink-0" />
              {message.error}
            </div>
          )}
        </div>
      </div>
    );
  }
  return <div className="text-dim text-center text-[11px] italic">{message.text}</div>;
}

// ---------- Composer (the command bar input) --------------------------------

function Composer({
  onSend,
  disabled,
  placeholder,
  status,
}: {
  onSend: (text: string) => boolean;
  disabled: boolean;
  placeholder: string;
  status: ChatConnectionStatus;
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize: snap to content up to ~6 rows, then internal scroll.
  // Snaps back to one row on submit because `value` clears.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 6 * 24; // ~6 rows at ~24px line-height
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    const ok = onSend(text);
    if (ok) setValue('');
  }

  const live = status === 'open';

  return (
    <div
      className={[
        'bg-panel/80 flex items-end gap-2 rounded-2xl border p-2 backdrop-blur-md transition-colors',
        'shadow-[0_10px_30px_rgba(0,0,0,0.45)]',
        live ? 'border-line focus-within:border-accent/50' : 'border-warn/30',
      ].join(' ')}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        className="text-text placeholder:text-dim/60 min-h-[24px] flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-50"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || !value.trim()}
        aria-label="Send message"
        title="Send (Enter). Shift+Enter for newline"
        className="bg-accent text-obsidian hover:bg-accent/90 mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ArrowUp size={15} weight="bold" />
      </button>
    </div>
  );
}

// ---------- Status strip (thin row under the composer) ----------------------

function StatusStrip({
  modelId,
  status,
  messageCount,
  transcriptOpen,
  onToggleTranscript,
}: {
  modelId: string;
  status: ChatConnectionStatus;
  messageCount: number;
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
}) {
  const tone = status === 'open' ? 'text-success' : status === 'error' ? 'text-warn' : 'text-dim';
  return (
    <div className="text-dim mt-1.5 flex items-center justify-between px-2 text-[10px] uppercase tracking-[0.15em]">
      <span className="flex items-center gap-2">
        <span className={tone}>
          {status === 'open' ? 'live' : status === 'connecting' ? 'connecting…' : status}
        </span>
        <span className="bg-line h-2.5 w-px" />
        <span>
          model <span className="text-text font-mono normal-case tracking-normal">{modelId}</span>
        </span>
      </span>
      {messageCount > 0 && (
        <button
          type="button"
          onClick={onToggleTranscript}
          className="hover:text-text inline-flex items-center gap-1 normal-case tracking-normal transition"
        >
          {transcriptOpen ? (
            <>
              hide log <CaretDown size={10} weight="bold" />
            </>
          ) : (
            <>
              {messageCount} message{messageCount === 1 ? '' : 's'}{' '}
              <CaretUp size={10} weight="bold" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
