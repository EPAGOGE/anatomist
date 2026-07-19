// useChatSocket — the WebSocket wiring for model chat (Subsystem 4).
//
// Extracted from ModelChat so multiple UI layouts can share one transport:
//   - CanvasChatDock (bottom-docked command bar on /canvas)
//   - ModelChat (side-panel variant, kept for reuse)
//
// The hook owns the WebSocket lifecycle + message state. To change how chat
// looks, swap the component. To change how it talks to the backend, change
// this hook. The two layers don't entangle.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMiBaseUrl } from '../../api/mi-client.js';

export type ChatRole = 'user' | 'model' | 'system';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  streaming?: boolean;
  error?: string;
};

export type ChatConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface UseChatSocket {
  messages: ChatMessage[];
  status: ChatConnectionStatus;
  /** Send a prompt. Returns false if the socket isn't open. */
  send: (prompt: string) => boolean;
  /** Clear the conversation (does not close the socket). */
  clear: () => void;
}

export function useChatSocket(modelId: string): UseChatSocket {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatConnectionStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const currentStreamingIdRef = useRef<string | null>(null);

  const wsUrl = useMemo(() => {
    const base = getMiBaseUrl();
    return base.replace(/^http/, 'ws') + '/chat/ws';
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('connecting');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!cancelled) setStatus('open');
    };
    ws.onclose = () => {
      if (!cancelled) setStatus('closed');
    };
    ws.onerror = () => {
      if (!cancelled) setStatus('error');
    };
    ws.onmessage = (ev) => {
      if (cancelled) return;
      let frame: { event?: string; text?: string; message?: string };
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.event === 'start') {
        const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        currentStreamingIdRef.current = id;
        setMessages((prev) => [...prev, { id, role: 'model', text: '', streaming: true }]);
      } else if (frame.event === 'token' && typeof frame.text === 'string') {
        const id = currentStreamingIdRef.current;
        if (!id) return;
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, text: m.text + frame.text } : m)),
        );
      } else if (frame.event === 'end') {
        const id = currentStreamingIdRef.current;
        currentStreamingIdRef.current = null;
        if (!id) return;
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)));
      } else if (frame.event === 'error') {
        const id = currentStreamingIdRef.current;
        currentStreamingIdRef.current = null;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, streaming: false, error: frame.message ?? 'unknown error' } : m,
          ),
        );
      }
    };

    return () => {
      cancelled = true;
      ws.close();
      wsRef.current = null;
    };
  }, [wsUrl]);

  const send = useCallback(
    (prompt: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        text: prompt,
      };
      setMessages((prev) => [...prev, userMessage]);
      ws.send(JSON.stringify({ prompt, model_id: modelId }));
      return true;
    },
    [modelId],
  );

  const clear = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, status, send, clear };
}
