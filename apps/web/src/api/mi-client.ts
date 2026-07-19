// Typed HTTP client for the MI Workbench backend (apps/mi-backend).
//
// Distinct from `client.ts` because the MI backend is a separate Python
// service running on a different port (default :8765) and is currently
// unauthenticated. When community/auth lands (Subsystem 4+), this client
// gains the same Bearer-token + refresh dance as `client.ts`. Until then,
// keeping them separate avoids accidentally muddling auth concerns.

const MI_BASE_URL =
  (import.meta.env.VITE_MI_API_URL as string | undefined) ?? 'http://localhost:8765';

export interface MiApiError {
  status: number;
  message: string;
  details?: unknown;
}

interface MiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Issue a request to the MI backend. Throws an MiApiError on non-2xx.
 * Network errors (backend not reachable) surface with status=0.
 */
export async function miFetch<T>(path: string, options: MiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;

  const finalHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...((headers as Record<string, string> | undefined) ?? {}),
  };

  let res: Response;
  try {
    res = await fetch(`${MI_BASE_URL}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw {
      status: 0,
      message:
        'MI backend unreachable. Start it with: cd apps/mi-backend && uvicorn main:app --reload --port 8765',
      details: e,
    } satisfies MiApiError;
  }

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
    const errObj = parsed as { detail?: string } | undefined;
    throw {
      status: res.status,
      message: errObj?.detail ?? `MI request failed with status ${res.status}`,
      details: parsed,
    } satisfies MiApiError;
  }

  return parsed as T;
}

export function getMiBaseUrl(): string {
  return MI_BASE_URL;
}
