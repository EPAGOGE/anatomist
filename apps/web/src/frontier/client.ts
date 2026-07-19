// Direct-from-browser calls to a user-supplied frontier provider. No SDK,
// no server hop for the common case: the user's key goes straight to the
// provider. Anthropic is opted into browser use via the documented
// dangerous-direct-browser header; OpenAI-compatible and Gemini accept
// browser calls for key auth; local runners (LM Studio, Ollama) need no key.
//
// Providers whose CORS blocks the browser (NVIDIA) route through the local
// mi-backend proxy (`proxy: true`) — server-to-server, no CORS.
//
// Every function throws a FrontierError with a human-readable message.

import { humanModel, type FrontierProvider, type ModelOption } from './providers.js';
import { getMiBaseUrl } from '../api/mi-client.js';

export interface FrontierMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface FrontierConfig {
  provider: FrontierProvider;
  apiKey: string;
  model: string;
  /** Overrides provider.baseUrl when set (custom / self-hosted endpoints). */
  baseUrl: string;
}

export class FrontierError extends Error {}

const DEFAULT_MAX_TOKENS = 1024;
const SYSTEM_PROMPT =
  'You are a frontier assistant embedded in the Anatomist platform — a ' +
  'cryptographically-verifiable reasoning ledger. Help the user reason ' +
  'about and build within the platform. Be concise, concrete, and honest ' +
  'about uncertainty.';

function resolveBase(cfg: FrontierConfig): string {
  return (cfg.baseUrl.trim() || cfg.provider.baseUrl).replace(/\/+$/, '');
}

/** Bearer value for OpenAI-compatible calls; local runners ignore it. */
function bearer(cfg: FrontierConfig): string {
  return cfg.apiKey.trim() || 'local';
}

/** Narrow an unknown JSON value to a nested string at the given path. */
function pickString(value: unknown, path: Array<string | number>): string | null {
  let cur: unknown = value;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : null;
}

async function readError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body: unknown = await res.json();
    detail =
      pickString(body, ['error', 'message']) ??
      pickString(body, ['error']) ??
      pickString(body, ['message']) ??
      '';
  } catch {
    // Response body wasn't JSON; fall back to status text only.
  }
  const base = `${res.status} ${res.statusText}`.trim();
  return detail ? `${base} — ${detail}` : base;
}

/** Map a thrown fetch failure (usually CORS/offline) to a clear message. */
function asFrontierError(err: unknown, provider: FrontierProvider): FrontierError {
  if (err instanceof FrontierError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    const hint = provider.browserDirect
      ? 'Check the base URL, your network, and that the key is valid. For a local runner, make sure its server is running.'
      : `${provider.label} blocks direct browser calls (CORS) — turn on "Route via local proxy".`;
    return new FrontierError(`Could not reach ${provider.label}. ${hint}`);
  }
  return new FrontierError(msg);
}

async function callAnthropic(
  cfg: FrontierConfig,
  messages: FrontierMessage[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${resolveBase(cfg)}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages,
    }),
    signal,
  });
  if (!res.ok) throw new FrontierError(await readError(res));
  const data: unknown = await res.json();
  const blocks = (data as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) =>
      typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '',
    )
    .join('')
    .trim();
}

async function callOpenAiCompatible(
  cfg: FrontierConfig,
  messages: FrontierMessage[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${resolveBase(cfg)}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer(cfg)}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
    signal,
  });
  if (!res.ok) throw new FrontierError(await readError(res));
  const data: unknown = await res.json();
  return (pickString(data, ['choices', 0, 'message', 'content']) ?? '').trim();
}

async function callGemini(
  cfg: FrontierConfig,
  messages: FrontierMessage[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${resolveBase(cfg)}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    signal,
  });
  if (!res.ok) throw new FrontierError(await readError(res));
  const data: unknown = await res.json();
  return (pickString(data, ['candidates', 0, 'content', 'parts', 0, 'text']) ?? '').trim();
}

/** Route through the local mi-backend, which calls the provider server-side
 *  (no browser CORS). Used for providers with `browserDirect: false`. */
async function callViaProxy(
  cfg: FrontierConfig,
  messages: FrontierMessage[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${getMiBaseUrl()}/frontier/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: cfg.provider.kind,
        base_url: resolveBase(cfg),
        api_key: cfg.apiKey,
        model: cfg.model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages,
      }),
      signal,
    });
  } catch {
    throw new FrontierError(
      'Local proxy unreachable. Start the mi-backend (uvicorn on :8765) to use CORS-blocked providers.',
    );
  }
  if (!res.ok) throw new FrontierError(await readError(res));
  const data: unknown = await res.json();
  return (pickString(data, ['text']) ?? '').trim();
}

export interface CallOptions {
  maxTokens?: number;
  signal?: AbortSignal;
  /** Force the local proxy (CORS-blocked hosts). */
  proxy?: boolean;
}

/** Send the conversation to the configured frontier and return its reply. */
export async function callFrontier(
  cfg: FrontierConfig,
  messages: FrontierMessage[],
  opts: CallOptions = {},
): Promise<string> {
  if (cfg.provider.requiresKey && !cfg.apiKey.trim()) throw new FrontierError('No API key set.');
  if (!cfg.model.trim()) throw new FrontierError('No model set.');
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  try {
    if (opts.proxy) return await callViaProxy(cfg, messages, maxTokens, opts.signal);
    switch (cfg.provider.kind) {
      case 'anthropic':
        return await callAnthropic(cfg, messages, maxTokens, opts.signal);
      case 'gemini':
        return await callGemini(cfg, messages, maxTokens, opts.signal);
      case 'openai':
        return await callOpenAiCompatible(cfg, messages, maxTokens, opts.signal);
    }
  } catch (err) {
    throw asFrontierError(err, cfg.provider);
  }
}

/** Lightweight connection check: one tiny round-trip that exercises the key,
 *  model, and transport (direct or proxy) all at once. */
export async function testFrontier(cfg: FrontierConfig, proxy: boolean): Promise<void> {
  const reply = await callFrontier(cfg, [{ role: 'user', content: 'Reply with just: ok' }], {
    maxTokens: 8,
    proxy,
  });
  if (!reply) throw new FrontierError('Connected, but the model returned no text.');
}

// ---------- Model discovery ----------

/** Pull model ids out of an OpenAI `{data:[{id}]}` or proxy `{models:[…]}`. */
function extractModelIds(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const idOf = (m: unknown): string =>
    typeof m === 'string'
      ? m
      : typeof m === 'object' && m && 'id' in m
        ? String((m as { id: unknown }).id)
        : '';
  if (Array.isArray(record.data)) return record.data.map(idOf).filter(Boolean);
  if (Array.isArray(record.models)) return record.models.map(idOf).filter(Boolean);
  return [];
}

async function listModelsDirect(cfg: FrontierConfig): Promise<string[]> {
  const res = await fetch(`${resolveBase(cfg)}/models`, {
    headers: cfg.apiKey.trim() ? { authorization: `Bearer ${bearer(cfg)}` } : {},
  });
  if (!res.ok) throw new FrontierError(await readError(res));
  return extractModelIds(await res.json());
}

async function listModelsProxy(cfg: FrontierConfig): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${getMiBaseUrl()}/frontier/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_url: resolveBase(cfg), api_key: cfg.apiKey }),
    });
  } catch {
    throw new FrontierError('Local proxy unreachable. Start the mi-backend on :8765.');
  }
  if (!res.ok) throw new FrontierError(await readError(res));
  return extractModelIds(await res.json());
}

/** Fetch the provider's live model list (OpenAI-compatible `/models`) and
 *  return it human-named. Empty for providers that aren't discoverable. */
export async function listModels(cfg: FrontierConfig, proxy: boolean): Promise<ModelOption[]> {
  if (!cfg.provider.discoverable) return [];
  try {
    const ids = proxy ? await listModelsProxy(cfg) : await listModelsDirect(cfg);
    const options = ids.map((id) => ({ id, label: humanModel(id) }));
    return options.sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    throw asFrontierError(err, cfg.provider);
  }
}
