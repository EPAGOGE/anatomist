// External-API chokepoint — F-0 Task 105 rail-keeper #11.
//
// All outbound HTTP from the platform to external services routes
// through this module. Per BUILD_RAILS.md rail-keepers #11, #12, #13,
// #15: one chokepoint handles retries with backoff, rate-limit
// awareness, error normalization, and required emission-classification
// tagging. Per-feature direct fetch() calls are forbidden.
//
// Today's consumer: huggingface.ts (Task 105). Future consumers:
// github.ts (Task 106 — OAuth + repo push), and any other external
// integration that lands later.
//
// This module is INTENTIONALLY MINIMAL — it does not yet emit
// chain events for external calls (that's a future rail-keeper
// when the external-api-emission-classification table is built).
// Today it enforces the chokepoint property and the rate-limit /
// retry / error-normalization behaviors.

import { setTimeout as sleep } from 'node:timers/promises';
import type { ExternalCallSiteTag } from './emission-classification.js';

// ---- types ----

/** Normalized error class for external-call failures. */
export class ExternalFetchError extends Error {
  constructor(
    message: string,
    public readonly site: string,
    public readonly kind:
      | 'network'
      | 'timeout'
      | 'rate-limited'
      | 'http-4xx'
      | 'http-5xx'
      | 'invalid-response',
    public readonly status?: number,
    public readonly body?: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExternalFetchError';
  }
}

export interface ExternalFetchOptions {
  /** Call-site tag. Required. Rail-keeper #15. */
  readonly tag: ExternalCallSiteTag;
  /** Fully-qualified URL. */
  readonly url: string;
  /** HTTP method. Defaults to 'GET'. */
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Outgoing headers. Authorization / User-Agent applied here. */
  readonly headers?: Record<string, string>;
  /** Query parameters appended to url. */
  readonly query?: Record<string, string | number | undefined>;
  /** Request body (JSON-encoded if object). */
  readonly body?: unknown;
  /**
   * Per-request timeout in milliseconds. Default 15s. Captures the
   * end-to-end deadline including retries.
   */
  readonly timeoutMs?: number;
  /**
   * Max retries on 5xx / 429 / network errors. Default 3. Total
   * attempts = retries + 1. 4xx errors are NOT retried.
   */
  readonly maxRetries?: number;
  /**
   * Rate-limit key for token-bucket-style internal limiting. Rail-
   * keeper #13: the chokepoint honors documented external rate
   * limits before the platform triggers remote 429s. Defaults to
   * `tag.site` (one bucket per call site).
   */
  readonly rateLimitKey?: string;
}

export interface ExternalFetchResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

// ---- rate-limit bucket ----

interface Bucket {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefill: number;
}

// Per-process buckets. Keyed by rateLimitKey (default: tag.site).
// Conservative defaults: 10 requests/second per bucket. Specific
// services should set tighter limits at the consumer module level by
// configuring their own bucket via configureRateLimit().
const buckets = new Map<string, Bucket>();
const DEFAULT_BUCKET = { capacity: 10, refillPerSec: 10 };

export function configureRateLimit(
  rateLimitKey: string,
  config: { capacity: number; refillPerSec: number },
): void {
  buckets.set(rateLimitKey, {
    capacity: config.capacity,
    refillPerSec: config.refillPerSec,
    tokens: config.capacity,
    lastRefill: Date.now(),
  });
}

async function acquireToken(rateLimitKey: string): Promise<void> {
  let b = buckets.get(rateLimitKey);
  if (!b) {
    b = {
      capacity: DEFAULT_BUCKET.capacity,
      refillPerSec: DEFAULT_BUCKET.refillPerSec,
      tokens: DEFAULT_BUCKET.capacity,
      lastRefill: Date.now(),
    };
    buckets.set(rateLimitKey, b);
  }
  // Refill based on elapsed time.
  const now = Date.now();
  const elapsedSec = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(b.capacity, b.tokens + elapsedSec * b.refillPerSec);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return;
  }
  // Wait until the next token is available, then take it.
  const waitMs = Math.ceil(((1 - b.tokens) / b.refillPerSec) * 1000);
  await sleep(waitMs);
  b.tokens = Math.max(0, b.tokens - 1 + ((Date.now() - b.lastRefill) / 1000) * b.refillPerSec);
  b.lastRefill = Date.now();
}

// ---- main entry ----

/**
 * The chokepoint. Every outbound HTTP request from the platform
 * MUST go through this function. Direct fetch() calls outside
 * this module are forbidden by rail-keeper #11.
 */
export async function externalFetch<T = unknown>(
  options: ExternalFetchOptions,
): Promise<ExternalFetchResult<T>> {
  const { tag, url } = options;
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 3;
  const rateLimitKey = options.rateLimitKey ?? tag.site;

  // Pagination at the chokepoint (rail-keeper #12) is a feature of
  // higher-level wrappers (huggingface.searchDatasets, etc.), not of
  // externalFetch itself. externalFetch is the single-request
  // primitive. Pagination wrappers in consumer modules iterate over
  // it.

  const fullUrl = appendQuery(url, options.query);
  const requestInit: RequestInit = {
    method,
    headers: {
      'User-Agent': 'epagoge-platform/0 (+https://epagoge.dev)',
      Accept: 'application/json',
      ...options.headers,
    },
  };
  if (options.body !== undefined) {
    requestInit.body =
      typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!('Content-Type' in (requestInit.headers as Record<string, string>))) {
      (requestInit.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
  }

  let lastErr: ExternalFetchError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireToken(rateLimitKey);

    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(fullUrl, { ...requestInit, signal: controller.signal });
      globalThis.clearTimeout(timer);

      // Read body for status classification + return.
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        // Non-JSON body — keep raw text on error; pass null as body
        // on success to indicate "no parseable body".
        if (res.ok) {
          parsed = null;
        } else {
          throw new ExternalFetchError(
            `external call to ${tag.site} returned non-JSON body (status ${res.status})`,
            tag.site,
            res.status >= 500 ? 'http-5xx' : 'http-4xx',
            res.status,
            text,
          );
        }
      }

      if (res.ok) {
        return { status: res.status, headers: res.headers, body: parsed as T };
      }

      // 429 — rate-limited by remote. Retry with respect for Retry-After if provided.
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const retryMs = retryAfter
          ? Math.max(parseInt(retryAfter, 10), 1) * 1000
          : backoffMs(attempt);
        lastErr = new ExternalFetchError(
          `external call to ${tag.site} rate-limited (HTTP 429)`,
          tag.site,
          'rate-limited',
          429,
          text,
        );
        if (attempt < maxRetries) {
          await sleep(retryMs);
          continue;
        }
        throw lastErr;
      }

      // 5xx — retry.
      if (res.status >= 500) {
        lastErr = new ExternalFetchError(
          `external call to ${tag.site} failed (HTTP ${res.status})`,
          tag.site,
          'http-5xx',
          res.status,
          text,
        );
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      }

      // 4xx — no retry.
      throw new ExternalFetchError(
        `external call to ${tag.site} returned HTTP ${res.status}`,
        tag.site,
        'http-4xx',
        res.status,
        text,
      );
    } catch (err) {
      globalThis.clearTimeout(timer);
      if (err instanceof ExternalFetchError) {
        // Non-retriable 4xx or final 5xx/429 — throw.
        if (err.kind === 'http-4xx' || attempt === maxRetries) throw err;
        lastErr = err;
        continue;
      }
      // Network / timeout / unknown — wrap and possibly retry.
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
      lastErr = new ExternalFetchError(
        isAbort
          ? `external call to ${tag.site} timed out after ${timeoutMs}ms`
          : `external call to ${tag.site} network error`,
        tag.site,
        isAbort ? 'timeout' : 'network',
        undefined,
        undefined,
        err,
      );
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }
  }
  // Unreachable in practice (loop either returns or throws), but
  // TypeScript's flow analysis needs the explicit throw.
  throw (
    lastErr ??
    new ExternalFetchError(`external call to ${tag.site} exhausted retries`, tag.site, 'network')
  );
}

function appendQuery(url: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) parsed.searchParams.set(k, String(v));
  }
  return parsed.toString();
}

function backoffMs(attempt: number): number {
  // Exponential backoff with jitter: 250ms, 500ms, 1000ms, ...
  const base = 250 * 2 ** attempt;
  const jitter = Math.random() * 100;
  return base + jitter;
}

// Re-exports for consumer convenience.
export type { EmissionClassification, ExternalCallSiteTag } from './emission-classification.js';
