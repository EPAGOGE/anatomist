import { useEffect, useState } from 'react';
import {
  useFrontierStore,
  EMPTY_CREDS,
  EMPTY_RUNTIME,
  type FrontierStatus,
} from '../../frontier/store.js';
import {
  PROVIDERS,
  resolveProvider,
  isCustomId,
  humanModel,
  type ModelOption,
} from '../../frontier/providers.js';
import { testFrontier, listModels, FrontierError } from '../../frontier/client.js';

// Left rail of the Chat page: connect your own frontier provider. Keys live
// in this browser only; calls go directly from here to the provider, or via
// the local mi-backend proxy for CORS-blocked hosts (NVIDIA). Models are
// shown human-named and auto-discovered where the provider supports it.
export function FrontierPanel() {
  const s = useFrontierStore();
  const {
    providerId,
    active,
    customEndpoints,
    selectProvider,
    setApiKey,
    setModel,
    setBaseUrl,
    setForceProxy,
    setActive,
    setStatus,
    setDiscovered,
    addCustomEndpoint,
    removeCustomEndpoint,
    forget,
  } = s;
  const [showKey, setShowKey] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');

  const provider = resolveProvider(providerId, customEndpoints);
  // Per-provider credentials + runtime for whichever provider is in view.
  const { apiKey, model, baseUrl, forceProxy } = s.creds[providerId] ?? EMPTY_CREDS;
  const { status, statusMessage, discovered } = s.runtime[providerId] ?? EMPTY_RUNTIME;
  const connected = status === 'connected';
  const usable = model.trim() !== '' && (!provider.requiresKey || apiKey.trim() !== '');

  // Merge curated + discovered models (deduped); ensure the current model is
  // always selectable even if it isn't in either list.
  const modelOptions: ModelOption[] = (() => {
    const merged: ModelOption[] = [];
    const seen = new Set<string>();
    for (const m of [...provider.curatedModels, ...discovered]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    if (model && !seen.has(model)) merged.unshift({ id: model, label: humanModel(model) });
    return merged;
  })();

  // Silent background refresh of the model list — never surfaces an error
  // (if a local runner isn't up, the list just stays empty).
  async function detect() {
    if (!provider.discoverable) return;
    try {
      const list = await listModels({ provider, apiKey, model, baseUrl }, forceProxy);
      setDiscovered(list);
      if (!model && list[0]) setModel(list[0].id);
    } catch {
      // Provider/runner unreachable — leave the model list as-is.
    }
  }

  // Auto-refresh models whenever a usable provider is shown — on mount (i.e.
  // once you're logged in and open Chat) and on provider change. Fires for
  // keyless local runners and for keyed providers that already have a saved
  // key, so the list is fresh without any button. Keyed on providerId only to
  // avoid refetching on every keystroke.
  useEffect(() => {
    if (provider.discoverable && (!provider.requiresKey || apiKey.trim() !== '')) void detect();
  }, [providerId]);

  async function connect() {
    if (provider.requiresKey && !apiKey.trim()) {
      setStatus('error', 'Enter an API key first.');
      return;
    }
    setStatus('testing');
    try {
      await testFrontier({ provider, apiKey, model, baseUrl }, forceProxy);
      setStatus('connected', `Connected · ${humanModel(model) || provider.label}`);
      setActive(true);
      void detect(); // fill the model list now that the key is validated
    } catch (err) {
      setStatus('error', err instanceof FrontierError ? err.message : 'Connection failed.');
      setActive(false);
    }
  }

  function submitAdd() {
    const url = newBaseUrl.trim();
    if (!url) return;
    addCustomEndpoint(newLabel.trim() || url.replace(/^https?:\/\//, ''), url);
    setNewLabel('');
    setNewBaseUrl('');
    setShowAdd(false);
  }

  const inputCls =
    'w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-neutral-600 focus:outline-none';

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col gap-4 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-100">Frontier</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Bring your own model to help you build. Key stays in this browser.
        </p>
      </div>

      <StatusPill status={status} message={statusMessage} />

      <Field label="Provider">
        <select
          value={providerId}
          onChange={(e) => selectProvider(e.target.value)}
          className={inputCls}
        >
          <optgroup label="Providers">
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
          {customEndpoints.length > 0 && (
            <optgroup label="Your endpoints">
              {customEndpoints.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <div className="mt-1 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="text-[11px] text-neutral-400 transition hover:text-neutral-100"
          >
            + Add OpenAI-compatible endpoint
          </button>
          {isCustomId(providerId) && (
            <button
              type="button"
              onClick={() => removeCustomEndpoint(providerId)}
              className="text-[11px] text-neutral-500 transition hover:text-red-400"
            >
              Remove
            </button>
          )}
        </div>
        {showAdd && (
          <div className="mt-2 space-y-2 rounded border border-neutral-800 bg-neutral-950/60 p-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Name (e.g. My vLLM)"
              className={`${inputCls} py-1 text-xs`}
            />
            <input
              type="text"
              value={newBaseUrl}
              onChange={(e) => setNewBaseUrl(e.target.value)}
              placeholder="Base URL (…/v1)"
              spellCheck={false}
              className={`${inputCls} py-1 text-xs`}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submitAdd}
                disabled={!newBaseUrl.trim()}
                className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 transition hover:bg-white disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Field>

      {provider.editableBaseUrl && (
        <Field label="Base URL">
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider.baseUrl || 'https://…/v1'}
            spellCheck={false}
            className={inputCls}
          />
        </Field>
      )}

      <Field label="Model">
        {modelOptions.length > 0 ? (
          <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
            {modelOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model id"
            spellCheck={false}
            className={inputCls}
          />
        )}
      </Field>

      <Field label={provider.requiresKey ? 'API key' : 'API key (optional)'}>
        <div className="flex items-stretch gap-1">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.keyHint}
            autoComplete="off"
            spellCheck={false}
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="rounded border border-neutral-800 px-2 text-xs text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-100"
            title={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        {provider.keysUrl && (
          <a
            href={provider.keysUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-[11px] text-neutral-500 hover:text-neutral-300"
          >
            Get a {provider.label} key ↗
          </a>
        )}
      </Field>

      <label className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-neutral-300">
        <span className="flex flex-col">
          Route via local proxy
          <span className="text-[10px] text-neutral-600">needed for CORS-blocked hosts</span>
        </span>
        <input
          type="checkbox"
          checked={forceProxy}
          onChange={(e) => setForceProxy(e.target.checked)}
          className="h-4 w-4 accent-emerald-500"
        />
      </label>

      {!provider.browserDirect && !forceProxy && (
        <p className="rounded border border-amber-900/50 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-300/90">
          {provider.label} blocks direct browser calls. Turn on “Route via local proxy” above.
        </p>
      )}

      <button
        type="button"
        onClick={() => void connect()}
        disabled={status === 'testing'}
        className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'testing' ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
      </button>

      {usable && (
        <label className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-neutral-300">
          <span>Use {provider.label} for chat</span>
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 accent-emerald-500"
          />
        </label>
      )}

      <div className="mt-auto space-y-2 border-t border-neutral-800 pt-3">
        <p className="text-[11px] leading-relaxed text-neutral-600">
          Calls go directly to the provider from your machine (or via your local proxy). Your key is
          stored only in this browser and never reaches Anatomist servers.
        </p>
        {(apiKey || connected) && (
          <button
            type="button"
            onClick={forget}
            className="text-[11px] text-neutral-500 transition hover:text-red-400"
          >
            Forget key
          </button>
        )}
      </div>
    </aside>
  );
}

function StatusPill({ status, message }: { status: FrontierStatus; message: string | null }) {
  const tone: Record<FrontierStatus, { dot: string; text: string; label: string }> = {
    idle: { dot: 'bg-neutral-600', text: 'text-neutral-500', label: 'Not connected' },
    testing: { dot: 'bg-amber-400', text: 'text-amber-300', label: 'Connecting...' },
    connected: { dot: 'bg-dim/60', text: 'text-dim', label: 'Connected' },
    error: { dot: 'bg-red-500', text: 'text-red-300', label: 'Error' },
  };
  const t = tone[status];
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
      <span className={t.text}>{message ?? t.label}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      {children}
    </div>
  );
}
