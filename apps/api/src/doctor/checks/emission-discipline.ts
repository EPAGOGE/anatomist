// Doctor check: ADR-0039 emission discipline audit.
//
// Per ADR-0039 (the three-category chain-emission principle), every
// state-changing HTTP route handler MUST either:
//   (a) Emit a chain event via an `appendXxxEvent` helper, OR
//   (b) Appear in the named-exceptions allowlist below.
//
// This check is the machine-readable enforcement of rail-keeper #15
// (External-API emission classification) and the deferred "doctor check
// that enforces ADR-0039 programmatically" item from BUILD_RAILS.md's
// "Deferred rail-keepers" section. Converts the discipline from
// honor-system to machine-checked.
//
// What it does:
//   1. Scans .ts files under apps/api/src/ for app.{post,put,delete,patch}
//      registrations
//   2. Identifies the route path + the handler function scope
//   3. Searches the handler scope for any `append*` emission helper call
//   4. Reports state-changing routes that DO NOT emit AND are NOT in
//      the named-exceptions allowlist
//
// What it explicitly does NOT do (deliberate scope limits):
//   - Verify the emission goes to the RIGHT chain (a future fully-typed
//     emission classification will catch this; today the chain is
//     inferable from the helper name)
//   - Verify the payload schema matches the route's purpose (separate
//     concern; @epagoge/shared schemas already type-check)
//   - Check read-only routes don't emit (the false-positive cost is
//     high — many GETs validly compute via the orchestrator which emits
//     ai-interaction; left for future tooling)
//
// Per the WATCHER_CONTRACT, this check IS the operationalization that
// closes the long-running Lane 11 cascade flagged in HaCk-A-tHoN
// IDEA-071 (reasoning-chain seed obligation enforced by doctor check)
// and the deferred-rail-keepers list in BUILD_RAILS.md.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

// Routes that are state-changing but DO NOT emit a chain event, per the
// ADR-0039 named exceptions. Format: `METHOD path`.
const NAMED_EXCEPTIONS = new Set<string>([
  // Named exception #3: chain pins are per-user soft anchors, not chain
  // modifications. See ADR-0039.
  'POST /chains/:id/pins',
  'DELETE /chains/:id/pins/:pin_id',
  // Read-only despite POST verb (body-shape only; deterministic validation).
  'POST /architectures/validate',
  // Read-only despite POST verb: deterministic price estimate from the GPU
  // catalog. No state change, nothing to attest.
  'POST /compute/estimate',
  // Emits transitively via the AI orchestrator (which itself emits
  // ai-interaction). The orchestrator call IS the emission; the route
  // handler is a thin wrapper. The static scanner can't follow into
  // the orchestrator's body from the route's handler scope, so these
  // routes need explicit allowlisting with the transitive-emission
  // justification.
  'POST /architectures/explain-error',
  'POST /ai/chat',
  // Chat sessions are plain per-user UI state (conversation cache), not
  // attested platform history — deliberately chain-less (see server.ts:
  // "Plain UI state (no chain event); auth-required, owner-scoped rows").
  'PUT /chat/sessions/:id',
  'DELETE /chat/sessions/:id',
]);

// Helpers whose name indicates an emission. Regex-friendly form.
// Pattern: append<Something>{recognized-suffix}.
//
// The suffix list is itself a small discipline — emission helpers
// should be named with a recognized suffix so this check can detect
// them. When a new event kind ships, add its suffix here AND the
// helper name follows the convention. This is the "extension-via-
// allowlist-with-justification" pattern (same shape as NAMED_EXCEPTIONS
// for routes).
//
// Recognized suffixes (sorted by introduction order):
//   Event, Failed, Emitted, Created, Updated, Removed, Issued, Revoked
//   Logout, Login, Refreshed, Referenced, WithPool — initial Task-105 set
//   Exported, Reasoning — added 2026-05-23 during Task 106 (the doctor
//     caught appendCodeExported missing from the recognized set; the
//     fix is documented inline so future contributors can extend it)
const EMISSION_HELPER_RE =
  /\bappend[A-Z][A-Za-z0-9]+(?:Event|Failed|Emitted|Created|Updated|Removed|Issued|Revoked|Logout|Login|Refreshed|Referenced|Exported|Reasoning|WithPool)\b/;

// State-changing HTTP method verbs per ADR-0039 Category 1.
const STATE_CHANGING_METHODS = new Set(['post', 'put', 'delete', 'patch']);

interface RouteFinding {
  method: string;
  path: string;
  file: string;
  emitsEvent: boolean;
  inAllowlist: boolean;
}

/**
 * Locates the matching closing brace for a function body whose opening
 * brace is at `start`. Simple brace-counting; tolerates strings and
 * comments well enough for our route-handler shapes.
 */
function findClosingBrace(src: string, start: number): number {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Scans a single source file for app.<method>(<path>, <handler>)
 * registrations. Returns findings for state-changing routes only.
 */
function scanFile(filePath: string, src: string): RouteFinding[] {
  const findings: RouteFinding[] = [];
  // Match: app.post('/path' or app.post<...>('/path' or app.post(`/path`
  // Captures: method, path
  const routeRe = /app\.(post|put|delete|patch|get)(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(src)) !== null) {
    const method = m[1]!.toLowerCase();
    const path = m[2]!;
    if (!STATE_CHANGING_METHODS.has(method)) continue;

    // Find the opening brace of the handler body. The handler starts
    // somewhere after the path; locate the next `{` that opens the body.
    // Heuristic: scan from end-of-match for the first '{' that isn't
    // inside parens. Adequate for the platform's route-handler shape.
    const afterPath = routeRe.lastIndex;
    let bodyStart = -1;
    let parenDepth = 0;
    for (let i = afterPath; i < src.length; i++) {
      const c = src[i];
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth--;
      else if (c === '{' && parenDepth === 0) {
        bodyStart = i;
        break;
      }
    }
    if (bodyStart === -1) continue;
    const bodyEnd = findClosingBrace(src, bodyStart);
    if (bodyEnd === -1) continue;
    const body = src.slice(bodyStart, bodyEnd + 1);
    const emitsEvent = EMISSION_HELPER_RE.test(body);
    const key = `${method.toUpperCase()} ${path}`;
    const inAllowlist = NAMED_EXCEPTIONS.has(key);
    findings.push({
      method: method.toUpperCase(),
      path,
      file: filePath,
      emitsEvent,
      inAllowlist,
    });
  }
  return findings;
}

function walk(dir: string, root: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) acc.push(full);
  }
}

/**
 * Doctor check that enforces ADR-0039 emission discipline.
 *
 * Discovers all state-changing route handlers and reports any that
 * neither emit a chain event nor appear in the named-exceptions
 * allowlist. Read-only routes are scanned for inventory but not failed
 * on (they may emit transitively through orchestrator calls and the
 * false-positive risk is high).
 */
export function emissionDisciplineCheck(apiSrcRoot: string): Check {
  return makeCheck('emission-discipline (ADR-0039)', async () => {
    const files: string[] = [];
    walk(apiSrcRoot, apiSrcRoot, files);
    const findings: RouteFinding[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      findings.push(...scanFile(relative(apiSrcRoot, file), src));
    }

    const stateChangingFindings = findings.filter((f) =>
      STATE_CHANGING_METHODS.has(f.method.toLowerCase()),
    );
    const violations = stateChangingFindings.filter((f) => !f.emitsEvent && !f.inAllowlist);

    if (violations.length > 0) {
      const lines = violations.map((v) => `  - ${v.method} ${v.path} (${v.file})`).join('\n');
      throw new Error(
        `${violations.length} state-changing route(s) do not emit a chain event and are not in the ADR-0039 named-exceptions allowlist:\n${lines}\n\nFix: emit via an appendXxxEvent helper, OR add the route to NAMED_EXCEPTIONS in emission-discipline.ts with a comment explaining the named-exception justification.`,
      );
    }

    const total = stateChangingFindings.length;
    const allowlisted = stateChangingFindings.filter((f) => f.inAllowlist).length;
    const emitted = stateChangingFindings.filter((f) => f.emitsEvent).length;
    return `${total} state-changing routes scanned: ${emitted} emit chain events, ${allowlisted} named-exception allowlisted, ${violations.length} violations`;
  });
}
