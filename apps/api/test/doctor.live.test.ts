import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { runDoctor, formatReport } from '../src/doctor/index.js';
import type { DoctorReport } from '../src/doctor/index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';

async function dbReachable(): Promise<boolean> {
  const probe = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    const client = await probe.connect();
    client.release();
    await probe.end();
    return true;
  } catch {
    await probe.end().catch(() => undefined);
    return false;
  }
}

const live = await dbReachable();
const describeLive = live ? describe : describe.skip;

// Concurrent-writer tolerance.
//
// `runDoctor()` walks several chains. When this file runs in parallel
// with other test files that POST /auth/register etc., the doctor can
// observe mid-write state on the auth-events chain — the chain_heads
// row is updated and the event row is inserted atomically inside one
// transaction, but a separately-connected reader may briefly see the
// head pointer pointing to an event whose causal_predecessors are
// still being resolved.
//
// The doctor's chain-head checks are already tolerant of concurrent
// writers (walked ≤ event_count). The remaining failure mode is
// timing-dependent: a single doctor run may fall inside someone
// else's transaction window. The pragmatic fix per ADR-0027's
// "document why the race is acceptable" option: re-run the doctor on
// failure, with a small jittered backoff, up to RETRIES times. Once
// other test files finish writing, the state stabilizes and the
// retry succeeds. If the doctor genuinely failed (not a race), all
// retries fail and the test surfaces the error.
const RETRIES = 3;
const BACKOFF_MS = 150;
// The doctor runs ~25 checks, each up to a couple of seconds against
// the real database. The default 5s test timeout is too tight with
// the retry budget on top; allow a generous ceiling.
const TEST_TIMEOUT_MS = 30_000;

async function runDoctorWithRetry(): Promise<DoctorReport> {
  let lastReport: DoctorReport | null = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const report = await runDoctor();
    if (report.ok) return report;
    lastReport = report;
    await new Promise((resolve) =>
      setTimeout(resolve, BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * 100)),
    );
  }
  return lastReport!;
}

describeLive('doctor (live, full suite)', () => {
  it(
    'reports OK on a healthy environment',
    async () => {
      process.env.DATABASE_URL = DATABASE_URL;
      process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
      const report = await runDoctorWithRetry();
      if (!report.ok) {
        // Print so debugging is easy when this fires in CI.
        console.error(formatReport(report));
      }
      expect(report.ok).toBe(true);
      expect(report.failed).toBe(0);
      expect(report.total).toBeGreaterThanOrEqual(10);
      expect(report.results.find((r) => r.name === 'ledger-end-to-end')?.status).toBe('ok');
    },
    TEST_TIMEOUT_MS,
  );

  it('skips DB and Redis checks when opted out', async () => {
    const report = await runDoctor({ skipDatabase: true, skipRedis: true });
    expect(report.results.find((r) => r.name === 'postgres-connection')?.status).toBe('skip');
    expect(report.results.find((r) => r.name === 'ledger-end-to-end')?.status).toBe('skip');
    expect(report.results.find((r) => r.name === 'redis-connection')?.status).toBe('skip');
  });
});
