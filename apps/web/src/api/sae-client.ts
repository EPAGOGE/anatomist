// Typed HTTP client for the SAE sidecar (apps/sae-backend, default :8766).
//
// A separate service from the MI backend by design: sae_lens pins its own
// TransformerLens/torch versions, so it lives in its own venv behind its own
// port. Same degrade-to-stub contract; if the sidecar is down, SAE probes
// render labeled stubs.

const SAE_BASE_URL =
  (import.meta.env.VITE_SAE_API_URL as string | undefined) ?? 'http://localhost:8766';

export interface SaeApiError {
  status: number;
  message: string;
}

interface SaeFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function saeFetch<T>(path: string, options: SaeFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  let res: Response;
  try {
    res = await fetch(`${SAE_BASE_URL}${path}`, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(headers as Record<string, string>) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw {
      status: 0,
      message: 'SAE sidecar not reachable (is it running on :8766?)',
    } as SaeApiError;
  }
  if (!res.ok) {
    let message = `SAE sidecar error ${res.status}`;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data.detail) message = data.detail;
    } catch {
      // keep default
    }
    throw { status: res.status, message } as SaeApiError;
  }
  return (await res.json()) as T;
}
