// Frontier providers a user can bring their own key for. The Chat page's
// left panel reads this registry to render provider options; the client
// (./client.ts) switches on `kind` to shape the request.
//
// Model names are shown in "human view" (curated labels + a formatter for
// discovered ids). OpenAI-compatible providers are `discoverable` — their
// live model list is fetched from `/models` and merged into the picker.
//
// Keys never leave the browser (direct calls) — except CORS-blocked hosts
// (`browserDirect: false`, e.g. NVIDIA) which route through the local
// mi-backend proxy. Local runners (LM Studio, Ollama) need no key.

export type ProviderKind = 'anthropic' | 'openai' | 'gemini';

/** A model choice: `id` is sent to the API, `label` is shown to the user. */
export interface ModelOption {
  id: string;
  label: string;
}

export interface FrontierProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  editableBaseUrl: boolean;
  /** Curated, human-named models shown before/without live discovery. */
  curatedModels: ModelOption[];
  /** Selected by default; empty for providers with no curated list. */
  defaultModel: string;
  /** True when a live `/models` list can be fetched and merged in. */
  discoverable: boolean;
  keyHint: string;
  keysUrl: string;
  browserDirect: boolean;
  requiresKey: boolean;
}

/** A user-registered OpenAI-compatible endpoint (persisted in the store). */
export interface CustomEndpoint {
  id: string;
  label: string;
  baseUrl: string;
}

export const PROVIDERS: readonly FrontierProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    editableBaseUrl: false,
    curatedModels: [
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-fable-5', label: 'Fable 5' },
    ],
    defaultModel: 'claude-sonnet-5',
    discoverable: false,
    keyHint: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    browserDirect: true,
    requiresKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    editableBaseUrl: false,
    curatedModels: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
      { id: 'o3', label: 'o3' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],
    defaultModel: 'gpt-4o',
    discoverable: true,
    keyHint: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
    browserDirect: true,
    requiresKey: true,
  },
  {
    id: 'google',
    label: 'Google',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    editableBaseUrl: false,
    curatedModels: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    ],
    defaultModel: 'gemini-2.0-flash',
    discoverable: false,
    keyHint: 'AIza…',
    keysUrl: 'https://aistudio.google.com/app/apikey',
    browserDirect: true,
    requiresKey: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    editableBaseUrl: true,
    curatedModels: [],
    defaultModel: '',
    discoverable: true,
    keyHint: 'not required',
    keysUrl: '',
    browserDirect: true,
    requiresKey: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    editableBaseUrl: true,
    curatedModels: [],
    defaultModel: '',
    discoverable: true,
    keyHint: 'not required',
    keysUrl: '',
    browserDirect: true,
    requiresKey: false,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    editableBaseUrl: true,
    curatedModels: [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B' },
      { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B' },
      { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1' },
    ],
    defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    discoverable: true,
    keyHint: 'nvapi-…',
    keysUrl: 'https://build.nvidia.com',
    browserDirect: false,
    requiresKey: true,
  },
] as const;

export const DEFAULT_PROVIDER_ID = 'anthropic';

export function providerById(id: string): FrontierProvider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}

/** Human-name a raw model id. Curated labels win; this handles discovered
 *  ids — mainly Anthropic-style (`claude-opus-4-8` → `Opus 4.8`); anything
 *  else (e.g. `gpt-4o`, `qwen2.5-coder:14b`) is already recognizable, so it
 *  is returned unchanged. */
export function humanModel(id: string): string {
  if (id.startsWith('claude-')) {
    const parts = id.slice('claude-'.length).split('-');
    const familyIdx = parts.findIndex((p) => /[a-z]/i.test(p));
    if (familyIdx >= 0) {
      const family = parts[familyIdx]!;
      const cap = family.charAt(0).toUpperCase() + family.slice(1);
      const version = parts.filter((_, i) => i !== familyIdx).join('.');
      return version ? `${cap} ${version}` : cap;
    }
  }
  return id;
}

export function customEndpointToProvider(ep: CustomEndpoint): FrontierProvider {
  return {
    id: ep.id,
    label: ep.label,
    kind: 'openai',
    baseUrl: ep.baseUrl,
    editableBaseUrl: false,
    curatedModels: [],
    defaultModel: '',
    discoverable: true,
    keyHint: 'API key (if the endpoint needs one)',
    keysUrl: '',
    browserDirect: true,
    requiresKey: false,
  };
}

/** Resolve a provider id against the built-ins and the user's custom list. */
export function resolveProvider(id: string, custom: readonly CustomEndpoint[]): FrontierProvider {
  if (id.startsWith('custom:')) {
    const ep = custom.find((e) => e.id === id);
    if (ep) return customEndpointToProvider(ep);
  }
  return providerById(id);
}

export function isCustomId(id: string): boolean {
  return id.startsWith('custom:');
}
