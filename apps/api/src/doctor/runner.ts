import type { Check, CheckContext, CheckResult, DoctorReport } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Wraps a check function with timeout enforcement and error capture. A check
 * that throws or exceeds the timeout becomes a `CheckFail` rather than
 * crashing the runner.
 */
export function makeCheck(
  name: string,
  fn: (ctx: CheckContext) => Promise<string | undefined>,
): Check {
  return async (ctx: CheckContext): Promise<CheckResult> => {
    const start = performance.now();
    const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      const detail = await Promise.race([fn(ctx), timeoutPromise]);
      const durationMs = performance.now() - start;
      return detail
        ? { name, status: 'ok', durationMs, detail }
        : { name, status: 'ok', durationMs };
    } catch (err) {
      const durationMs = performance.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      return { name, status: 'fail', durationMs, error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export function makeSkip(name: string, reason: string): Check {
  return async (): Promise<CheckResult> => ({
    name,
    status: 'skip',
    durationMs: 0,
    reason,
  });
}

export async function runChecks(
  checks: readonly Check[],
  ctx: CheckContext = {},
): Promise<DoctorReport> {
  const start = performance.now();
  const results: CheckResult[] = [];
  // Checks run sequentially. Some hold exclusive resources (DB connections,
  // file locks); cross-check interference is more disruptive than slower
  // total runtime.
  for (const check of checks) {
    results.push(await check(ctx));
  }
  const passed = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const durationMs = performance.now() - start;
  return {
    ok: failed === 0,
    total: results.length,
    passed,
    failed,
    skipped,
    results,
    durationMs,
  };
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    if (r.status === 'ok') {
      const detail = r.detail ? ` (${r.detail})` : '';
      lines.push(`  ✓ ${r.name}${detail}  [${r.durationMs.toFixed(0)}ms]`);
    } else if (r.status === 'skip') {
      lines.push(`  - ${r.name}  [skipped: ${r.reason}]`);
    } else {
      lines.push(`  ✗ ${r.name}  [${r.durationMs.toFixed(0)}ms]`);
      lines.push(`      ${r.error}`);
    }
  }
  lines.push('');
  lines.push(
    `Doctor: ${report.passed}/${report.total} passed, ${report.failed} failed, ${report.skipped} skipped in ${report.durationMs.toFixed(0)}ms.`,
  );
  return lines.join('\n');
}
