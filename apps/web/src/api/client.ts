// Typed HTTP client for the EPAGOGE API.
//
// Local-first: the app has no login, so there is no token injection or
// refresh dance here anymore. Responsibilities:
//   - Decode JSON and surface structured errors as { code, message }.
//
// Kept thin on purpose: every endpoint is a regular fetch call wrapped by
// `apiFetch`. TanStack Query handles caching, retries, and lifecycle; this
// file is just the wire format.

const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function makeError(status: number, body: unknown): ApiError {
  const obj = body as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | undefined;
  return {
    status,
    code: obj?.error?.code ?? 'unknown',
    message: obj?.error?.message ?? `request failed with status ${status}`,
    details: obj?.error?.details,
  };
}

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Issue a request to the API. Throws an ApiError on non-2xx responses.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;

  const finalHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...((headers as Record<string, string> | undefined) ?? {}),
  };

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    throw makeError(res.status, parsed);
  }

  return parsed as T;
}
