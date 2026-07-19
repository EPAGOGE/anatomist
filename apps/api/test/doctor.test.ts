import { describe, it, expect } from 'vitest';
import { makeCheck, makeSkip, runChecks, formatReport } from '../src/doctor/runner.js';
import type { Check } from '../src/doctor/types.js';

describe('doctor runner', () => {
  it('passes when every check returns ok', async () => {
    const checks: Check[] = [
      makeCheck('ok-1', async () => 'all good'),
      makeCheck('ok-2', async () => undefined),
    ];
    const report = await runChecks(checks);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.results[0]).toMatchObject({ name: 'ok-1', status: 'ok', detail: 'all good' });
  });

  it('marks a thrown check as fail without crashing the runner', async () => {
    const checks: Check[] = [
      makeCheck('boom', async () => {
        throw new Error('explicit failure');
      }),
      makeCheck('ok', async () => undefined),
    ];
    const report = await runChecks(checks);
    expect(report.ok).toBe(false);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    const failed = report.results.find((r) => r.status === 'fail');
    expect(failed?.name).toBe('boom');
    expect(failed && 'error' in failed ? failed.error : undefined).toBe('explicit failure');
  });

  it('skip checks count as skipped, not failed', async () => {
    const checks: Check[] = [makeSkip('deferred', 'no upstream yet')];
    const report = await runChecks(checks);
    expect(report.ok).toBe(true);
    expect(report.skipped).toBe(1);
  });

  it('enforces per-check timeout', async () => {
    const checks: Check[] = [
      makeCheck('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return undefined;
      }),
    ];
    const report = await runChecks(checks, { timeoutMs: 50 });
    expect(report.ok).toBe(false);
    const failed = report.results[0];
    expect(failed?.status).toBe('fail');
    if (failed && 'error' in failed) {
      expect(failed.error).toMatch(/timed out/);
    }
  });

  it('formatReport produces readable output', async () => {
    const checks: Check[] = [
      makeCheck('a', async () => 'OK detail'),
      makeCheck('b', async () => {
        throw new Error('boom');
      }),
      makeSkip('c', 'deferred'),
    ];
    const report = await runChecks(checks);
    const text = formatReport(report);
    expect(text).toContain('✓ a');
    expect(text).toContain('✗ b');
    expect(text).toContain('- c');
    expect(text).toContain('boom');
    expect(text).toMatch(/1\/3 passed/);
  });
});
