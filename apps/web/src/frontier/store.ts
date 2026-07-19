// "Bring your own frontier" config for the Chat page. Persisted to
// localStorage (this browser only) so a refresh keeps every connection —
// same storage approach as the auth store. API keys are NEVER sent to
// EPAGOGE servers; ./client.ts calls providers directly, or (for CORS-blocked
// hosts like NVIDIA) via the local mi-backend proxy.
//
// Credentials are PER PROVIDER: each provider (and custom endpoint) keeps its
// own key/model/base-URL/proxy setting, all saved independently, so several
// stay "connected" at once. Selecting a provider just changes which one is in
// view and drives chat; it never clears another's key.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_PROVIDER_ID,
  resolveProvider,
  customEndpointToProvider,
  type CustomEndpoint,
  type FrontierProvider,
  type ModelOption,
} from './providers.js';

export type FrontierStatus = 'idle' | 'testing' | 'connected' | 'error';

/** Saved, per-provider credentials (persisted). */
export interface ProviderCreds {
  apiKey: string;
  model: string;
  baseUrl: string;
  forceProxy: boolean;
}

/** Transient, per-provider connection runtime (not persisted). */
export interface ProviderRuntime {
  status: FrontierStatus;
  statusMessage: string | null;
  discovered: ModelOption[];
}

export const EMPTY_CREDS: ProviderCreds = { apiKey: '', model: '', baseUrl: '', forceProxy: false };
export const EMPTY_RUNTIME: ProviderRuntime = {
  status: 'idle',
  statusMessage: null,
  discovered: [],
};

function defaultCreds(provider: FrontierProvider): ProviderCreds {
  return {
    apiKey: '',
    model: provider.defaultModel,
    baseUrl: '',
    forceProxy: !provider.browserDirect,
  };
}

interface FrontierState {
  /** Provider currently in view + driving chat when `active`. */
  providerId: string;
  /** Global: route chat prompts to the selected frontier vs. the platform. */
  active: boolean;
  /** User-registered OpenAI-compatible endpoints (the panel's "+"). */
  customEndpoints: CustomEndpoint[];
  /** Per-provider saved credentials (persisted). */
  creds: Record<string, ProviderCreds>;
  /** Per-provider connection runtime (transient). */
  runtime: Record<string, ProviderRuntime>;

  selectProvider: (providerId: string) => void;
  setApiKey: (apiKey: string) => void;
  setModel: (model: string) => void;
  setBaseUrl: (baseUrl: string) => void;
  setForceProxy: (forceProxy: boolean) => void;
  setActive: (active: boolean) => void;
  setStatus: (status: FrontierStatus, message?: string | null) => void;
  setDiscovered: (models: ModelOption[]) => void;
  addCustomEndpoint: (label: string, baseUrl: string) => void;
  removeCustomEndpoint: (id: string) => void;
  forget: () => void;
}

/** The persisted subset of the store (see `partialize`). */
type PersistedFrontier = Pick<FrontierState, 'providerId' | 'active' | 'customEndpoints' | 'creds'>;

function withCred(s: FrontierState, patch: Partial<ProviderCreds>): Pick<FrontierState, 'creds'> {
  const current =
    s.creds[s.providerId] ?? defaultCreds(resolveProvider(s.providerId, s.customEndpoints));
  return { creds: { ...s.creds, [s.providerId]: { ...current, ...patch } } };
}

function withRuntime(
  s: FrontierState,
  patch: Partial<ProviderRuntime>,
): Pick<FrontierState, 'runtime'> {
  const current = s.runtime[s.providerId] ?? EMPTY_RUNTIME;
  return { runtime: { ...s.runtime, [s.providerId]: { ...current, ...patch } } };
}

const initialCreds = defaultCreds(resolveProvider(DEFAULT_PROVIDER_ID, []));

export const useFrontierStore = create<FrontierState>()(
  persist(
    (set) => ({
      providerId: DEFAULT_PROVIDER_ID,
      active: false,
      customEndpoints: [],
      creds: { [DEFAULT_PROVIDER_ID]: initialCreds },
      runtime: {},

      selectProvider: (providerId) =>
        set((s) => {
          // Seed default creds for a provider selected for the first time;
          // never touch other providers' saved keys.
          if (s.creds[providerId]) return { providerId };
          const provider = resolveProvider(providerId, s.customEndpoints);
          return { providerId, creds: { ...s.creds, [providerId]: defaultCreds(provider) } };
        }),

      setApiKey: (apiKey) =>
        set((s) => ({
          ...withCred(s, { apiKey }),
          ...withRuntime(s, { status: 'idle', statusMessage: null }),
        })),
      setModel: (model) => set((s) => withCred(s, { model })),
      setBaseUrl: (baseUrl) => set((s) => withCred(s, { baseUrl })),
      setForceProxy: (forceProxy) => set((s) => withCred(s, { forceProxy })),
      setActive: (active) => set({ active }),
      setStatus: (status, message = null) =>
        set((s) => withRuntime(s, { status, statusMessage: message })),
      setDiscovered: (discovered) => set((s) => withRuntime(s, { discovered })),

      addCustomEndpoint: (label, baseUrl) =>
        set((s) => {
          const id = `custom:${crypto.randomUUID()}`;
          const endpoint: CustomEndpoint = {
            id,
            label: label.trim() || baseUrl.trim(),
            baseUrl: baseUrl.trim(),
          };
          return {
            customEndpoints: [...s.customEndpoints, endpoint],
            creds: { ...s.creds, [id]: defaultCreds(customEndpointToProvider(endpoint)) },
            providerId: id,
          };
        }),

      removeCustomEndpoint: (id) =>
        set((s) => {
          const customEndpoints = s.customEndpoints.filter((e) => e.id !== id);
          const creds = { ...s.creds };
          const runtime = { ...s.runtime };
          delete creds[id];
          delete runtime[id];
          if (s.providerId !== id) return { customEndpoints, creds, runtime };
          if (!creds[DEFAULT_PROVIDER_ID]) {
            creds[DEFAULT_PROVIDER_ID] = defaultCreds(
              resolveProvider(DEFAULT_PROVIDER_ID, customEndpoints),
            );
          }
          return { customEndpoints, creds, runtime, providerId: DEFAULT_PROVIDER_ID };
        }),

      forget: () =>
        set((s) => ({
          ...withCred(s, { apiKey: '' }),
          ...withRuntime(s, { status: 'idle', statusMessage: null }),
          active: false,
        })),
    }),
    {
      name: 'epagoge.frontier',
      version: 1,
      // Persist the selection + per-provider credentials; runtime is transient.
      partialize: (state) => ({
        providerId: state.providerId,
        active: state.active,
        customEndpoints: state.customEndpoints,
        creds: state.creds,
      }),
      // v0 stored a single flat key/model/baseUrl/forceProxy. Fold it into the
      // per-provider map so an existing connection isn't lost on upgrade.
      migrate: (persisted, version): PersistedFrontier => {
        if (version >= 1 || !persisted || typeof persisted !== 'object') {
          return persisted as PersistedFrontier;
        }
        const p = persisted as Record<string, unknown>;
        const providerId = typeof p.providerId === 'string' ? p.providerId : DEFAULT_PROVIDER_ID;
        const customEndpoints = Array.isArray(p.customEndpoints)
          ? (p.customEndpoints as CustomEndpoint[])
          : [];
        const provider = resolveProvider(providerId, customEndpoints);
        return {
          providerId,
          active: p.active === true,
          customEndpoints,
          creds: {
            [providerId]: {
              apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
              model: typeof p.model === 'string' && p.model ? p.model : provider.defaultModel,
              baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
              forceProxy:
                typeof p.forceProxy === 'boolean' ? p.forceProxy : !provider.browserDirect,
            },
          },
        };
      },
    },
  ),
);
