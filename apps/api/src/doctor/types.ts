// Doctor framework: pluggable runtime self-check.
//
// Each `Check` is an async function that returns a structured `CheckResult`.
// Checks are intentionally independent — a failure in one does not cascade.
// Each check has a name (used for reporting) and is time-bounded by the
// runner to prevent a single hung check from blocking the suite.

export interface CheckOk {
  readonly name: string;
  readonly status: 'ok';
  readonly durationMs: number;
  readonly detail?: string;
}

export interface CheckFail {
  readonly name: string;
  readonly status: 'fail';
  readonly durationMs: number;
  readonly error: string;
}

export interface CheckSkip {
  readonly name: string;
  readonly status: 'skip';
  readonly durationMs: 0;
  readonly reason: string;
}

export type CheckResult = CheckOk | CheckFail | CheckSkip;

export interface CheckContext {
  /** Default 10s. Individual checks may take less. */
  readonly timeoutMs?: number;
}

export type Check = (ctx: CheckContext) => Promise<CheckResult>;

export interface DoctorReport {
  readonly ok: boolean;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly results: readonly CheckResult[];
  readonly durationMs: number;
}
