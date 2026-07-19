// Exponential backoff with jitter + circuit breaker.
//
// The Anthropic SDK already retries 429 and 5xx with exponential backoff
// (default max_retries=2). This module ADDs a process-wide circuit
// breaker so a sustained outage doesn't see every caller eat retry
// latency before failing. The breaker is keyed by base URL so an
// Anthropic outage doesn't trip a separate provider's calls.

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the breaker opens. */
  failureThreshold: number;
  /** Milliseconds the breaker stays open before tentatively half-opening. */
  resetTimeoutMs: number;
  /** Consecutive successes in half-open before fully closing. */
  successThreshold: number;
}

export const DEFAULT_BREAKER_OPTIONS: CircuitBreakerOptions = Object.freeze({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 2,
});

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;

  constructor(private readonly opts: CircuitBreakerOptions = DEFAULT_BREAKER_OPTIONS) {}

  /**
   * Run `fn` through the breaker. Throws `BreakerOpenError` immediately
   * when the breaker is open and the reset window hasn't expired.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.opts.resetTimeoutMs) {
        throw new BreakerOpenError(this.opts.resetTimeoutMs - (Date.now() - this.openedAt));
      }
      this.state = 'half-open';
      this.successes = 0;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    if (this.failures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  /** For doctor checks and observability. */
  inspect(): { state: BreakerState; failures: number; successes: number } {
    return { state: this.state, failures: this.failures, successes: this.successes };
  }
}

export class BreakerOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`circuit breaker is open; retry in ${retryAfterMs}ms`);
    this.name = 'BreakerOpenError';
  }
}

/**
 * Process-wide singleton, keyed by base URL. Multiple Anthropic clients
 * share the same breaker so a downstream incident doesn't get
 * concurrent re-attempts from every caller.
 */
const breakers = new Map<string, CircuitBreaker>();

export function getBreaker(key: string = 'anthropic'): CircuitBreaker {
  let b = breakers.get(key);
  if (!b) {
    b = new CircuitBreaker();
    breakers.set(key, b);
  }
  return b;
}

/** Sleep with jitter. Used by callers wanting application-level retries
 *  layered on top of the SDK's own retry. */
export async function backoff(attempt: number, baseMs = 250, capMs = 8000): Promise<void> {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = Math.random() * exp * 0.3;
  await new Promise((r) => setTimeout(r, exp + jitter));
}
