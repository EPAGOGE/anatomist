import { defineConfig } from 'vitest/config';

// Coverage thresholds are set to the current measurable baseline so CI catches
// regressions without failing on scaffolding. They MUST ratchet up as real
// code and tests land. Per ADR-0008 the reliability-bearing packages
// (packages/crypto, future packages/ledger, future packages/inference) target
// 100% line and branch coverage; raising the global thresholds to match is the
// expected migration path. Do not relax these further without a superseding ADR.
//
// The text reporter is given { skipFull: false } so 100%-covered files are
// listed in the per-file table — otherwise the default text reporter omits
// them, which gives the false impression they're uninstrumented.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Live integration tests share Postgres + Redis with other parallel
    // test files. Under contention (multiple files concurrently doing
    // HTTP round-trips that walk chains and emit signed events), the
    // default 5s per-test timeout is too tight. 30s is generous but
    // still surfaces genuine deadlocks within a reasonable wait. Per
    // ADR-0027's "document why the race is acceptable" option: live
    // tests are deliberately not isolated; the shared-fixture cost
    // shows up as wait time, not as wrong results.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        inline: [/^@epagoge\//],
      },
    },
    include: ['packages/**/*.{test,spec}.{ts,tsx}', 'apps/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'istanbul',
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.d.ts', 'apps/web/**'],
      thresholds: {
        // Global floors. Ratchet up as the remaining stub modules
        // (apps/api, packages/ai) grow real tests. Function floor is below
        // statements because apps/api/src and packages/ai/src skeletons have
        // many uncovered functions; the reliability-bearing per-path
        // thresholds below stay at 100%.
        statements: 70,
        branches: 55,
        functions: 70,
        lines: 70,
        // Per-path: reliability-bearing modules must stay at 100%.
        // Add more paths as @epagoge/ledger land.
        'packages/crypto/src/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/shared/src/reliability/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/shared/src/events/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/inference/src/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'packages/shared/src/codec/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // canonical.ts (pure-logic helpers) at 100%.
        // postgres.ts has many error-branch paths; tighten over time.
        'packages/ledger/src/canonical.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
