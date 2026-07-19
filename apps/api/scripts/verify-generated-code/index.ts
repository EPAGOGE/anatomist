// F-0 Criterion 3 verification harness — per ADR-0038.
//
// Generates PyTorch source for each representative architecture
// fixture, writes it to a temp dir, and shells to the Python runner
// to instantiate + forward + check output shape. Records results
// to a JSON evidence artifact.
//
// Environment requirement: a Python interpreter with `torch`
// installed. The runner returns status='skip' when torch isn't
// available, which the harness records as DEFERRED rather than
// failure — honest evidence that the codegen step ran successfully
// but the functional verification awaits a torch environment.
//
// Per the F-0 brief and the build doc Section 5.4: periodic-with-
// recorded-results is the pragmatic call. This script runs on
// demand; its JSON output is the evidence the criterion demands.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ComponentRegistry, loadMlDomain } from '@epagoge/components';
import { generatePytorch } from '@epagoge/codegen';
import { VERIFICATION_FIXTURES } from './fixtures.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNER_SCRIPT = join(__dirname, 'runner.py');
const RESULTS_DIR = join(__dirname, '..', '..', 'verification-results');

interface RunResult {
  readonly fixture_id: string;
  readonly class_name: string;
  readonly description: string;
  readonly codegen: {
    readonly ok: boolean;
    readonly bytes: number;
    readonly lines: number;
    readonly reason?: string;
  };
  readonly forward: {
    readonly status: 'pass' | 'fail' | 'skip';
    readonly reason: string | null;
    readonly output_shape: readonly number[] | null;
    readonly elapsed_ms: number;
  };
}

async function runFixture(
  registry: ComponentRegistry,
  pythonBin: string,
  workDir: string,
  fixture: (typeof VERIFICATION_FIXTURES)[number],
): Promise<RunResult> {
  // 1. Codegen.
  let code: string;
  try {
    code = generatePytorch(fixture.graph, registry);
  } catch (err) {
    return {
      fixture_id: fixture.id,
      class_name: '',
      description: fixture.description,
      codegen: {
        ok: false,
        bytes: 0,
        lines: 0,
        reason: err instanceof Error ? err.message : String(err),
      },
      forward: {
        status: 'fail',
        reason: 'codegen failed; forward not attempted',
        output_shape: null,
        elapsed_ms: 0,
      },
    };
  }

  const className = extractClassName(code);
  const modulePath = join(workDir, `${fixture.id.replace(/[^A-Za-z0-9_-]/g, '_')}.py`);
  writeFileSync(modulePath, code, 'utf8');

  // 2. Forward via the Python runner.
  const runnerSpec = {
    module_path: modulePath,
    class_name: className,
    inputs: fixture.forwardTest.inputs,
    expected_output_shape: fixture.forwardTest.expectedOutputShape,
    output_index: fixture.forwardTest.outputIndex ?? 0,
  };
  const runnerResult = await runPython(pythonBin, RUNNER_SCRIPT, JSON.stringify(runnerSpec));

  let parsed: RunResult['forward'];
  try {
    parsed = JSON.parse(runnerResult.stdout) as RunResult['forward'];
  } catch (err) {
    parsed = {
      status: 'fail',
      reason: `runner produced non-JSON stdout (exit=${runnerResult.code}): ${runnerResult.stdout.slice(0, 200)} | stderr=${runnerResult.stderr.slice(0, 200)} | parseError=${err instanceof Error ? err.message : String(err)}`,
      output_shape: null,
      elapsed_ms: 0,
    };
  }

  return {
    fixture_id: fixture.id,
    class_name: className,
    description: fixture.description,
    codegen: {
      ok: true,
      bytes: Buffer.byteLength(code, 'utf8'),
      lines: code.split('\n').length,
    },
    forward: parsed,
  };
}

function runPython(
  bin: string,
  script: string,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

function extractClassName(code: string): string {
  const m = code.match(/^class\s+(\w+)\s*\(nn\.Module\)/m);
  if (!m || !m[1]) throw new Error('could not find class name in generated code');
  return m[1];
}

function pythonBinary(): string {
  // Priority: dedicated torch venv if the user has set one up,
  // then `python3.13` (homebrew on macOS often has this), then `python3`.
  // The user controls this via env var EPAGOGE_TORCH_PYTHON.
  if (process.env.EPAGOGE_TORCH_PYTHON) return process.env.EPAGOGE_TORCH_PYTHON;
  const venvPython = join(__dirname, '.torch-venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

async function main(): Promise<void> {
  const registry = new ComponentRegistry();
  loadMlDomain(registry);

  const workDir = mkdtempSync(join(tmpdir(), 'epagoge-verify-'));
  const pythonBin = pythonBinary();

  console.log(`[verify] python: ${pythonBin}`);
  console.log(`[verify] workDir: ${workDir}`);
  console.log(`[verify] fixtures: ${VERIFICATION_FIXTURES.length}`);

  const results: RunResult[] = [];
  for (const fixture of VERIFICATION_FIXTURES) {
    process.stdout.write(`[verify] ${fixture.id} … `);
    const r = await runFixture(registry, pythonBin, workDir, fixture);
    results.push(r);
    if (!r.codegen.ok) {
      console.log(`CODEGEN FAIL (${r.codegen.reason ?? 'unknown'})`);
    } else if (r.forward.status === 'pass') {
      console.log(
        `PASS (${r.forward.elapsed_ms}ms, out=${JSON.stringify(r.forward.output_shape)})`,
      );
    } else if (r.forward.status === 'skip') {
      console.log(`SKIP (${r.forward.reason ?? 'unknown'})`);
    } else {
      console.log(`FAIL (${r.forward.reason ?? 'unknown'})`);
    }
  }

  // Aggregate summary.
  const codegenOk = results.filter((r) => r.codegen.ok).length;
  const forwardPass = results.filter((r) => r.forward.status === 'pass').length;
  const forwardSkip = results.filter((r) => r.forward.status === 'skip').length;
  const forwardFail = results.filter((r) => r.forward.status === 'fail').length;

  const summary = {
    run_at: new Date().toISOString(),
    python_bin: pythonBin,
    fixture_count: VERIFICATION_FIXTURES.length,
    codegen_ok: codegenOk,
    forward_pass: forwardPass,
    forward_skip: forwardSkip,
    forward_fail: forwardFail,
    results,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, 'verify-generated-code.latest.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  // Also append to a historical log so consecutive runs accumulate.
  const histPath = join(RESULTS_DIR, 'verify-generated-code.history.jsonl');
  const histLine = JSON.stringify(summary) + '\n';
  if (existsSync(histPath)) {
    const prev = readFileSync(histPath, 'utf8');
    writeFileSync(histPath, prev + histLine, 'utf8');
  } else {
    writeFileSync(histPath, histLine, 'utf8');
  }

  console.log('');
  console.log(`[verify] codegen ok: ${codegenOk}/${results.length}`);
  console.log(`[verify] forward: ${forwardPass} pass, ${forwardSkip} skip, ${forwardFail} fail`);
  console.log(`[verify] results written: ${outPath}`);

  // Exit code:
  //   0 - everything ran cleanly (PASS or SKIP).
  //   1 - one or more forward FAIL or codegen FAIL.
  if (forwardFail > 0 || codegenOk < results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[verify] unhandled error:', err);
  process.exitCode = 1;
});
