import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Reliability-bearing module paths. Per ADR-0008 these MUST NOT import
// @epagoge/ai (nor the Anthropic SDK directly). Per ADR-0007 these MUST NOT
// use clock-based time for causal ordering.
const reliabilityBearingPaths = [
  'packages/crypto/src/**/*.{ts,tsx}',
  'packages/shared/src/reliability/**/*.{ts,tsx}',
  'packages/shared/src/events/**/*.{ts,tsx}',
  'packages/shared/src/codec/**/*.{ts,tsx}',
  'packages/inference/src/**/*.{ts,tsx}',
];

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      '**/node_modules',
      'dist',
      '**/dist',
      'build',
      '**/build',
      '.turbo',
      'coverage',
      '**/coverage',
      '*.tsbuildinfo',
      '**/*.tsbuildinfo',
      // F-0 Criterion 3's Python virtualenv for torch verification — vendor
      // files shouldn't be linted as TypeScript.
      '**/.torch-venv/**',
      '**/.venv/**',
      '**/venv/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // ADR-0008: AI is forbidden in reliability-bearing modules.
  {
    files: reliabilityBearingPaths,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@epagoge/ai',
              message:
                '@epagoge/ai is forbidden in reliability-bearing modules. See docs/adrs/0008-ai-boundaries.md.',
            },
            {
              name: '@anthropic-ai/sdk',
              message:
                'Direct Anthropic SDK use is forbidden in reliability-bearing modules. See docs/adrs/0008-ai-boundaries.md.',
            },
          ],
          patterns: [
            {
              group: ['@epagoge/ai/*', '@anthropic-ai/*'],
              message:
                'AI provider modules are forbidden in reliability-bearing modules. See docs/adrs/0008-ai-boundaries.md.',
            },
          ],
        },
      ],
    },
  },
  // ADR-0007: clock-based time is forbidden for causal ordering. The four
  // selectors below cover Date.now(), Date.parse(), new Date(), and
  // Date(...). Display-time uses must be moved outside the listed paths.
  {
    files: reliabilityBearingPaths,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='Date'][callee.property.name='now']",
          message:
            'Date.now() is forbidden in causal/reliability paths; use causal_sequence_marker (bigint). See ADR-0007.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='Date'][callee.property.name='parse']",
          message: 'Date.parse() is forbidden in causal/reliability paths. See ADR-0007.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'new Date() is forbidden in causal/reliability paths; use causal_sequence_marker (bigint). See ADR-0007.',
        },
        {
          selector: "CallExpression[callee.type='Identifier'][callee.name='Date']",
          message:
            'Date(...) as a function is forbidden in causal/reliability paths. See ADR-0007.',
        },
      ],
    },
  },
  // Rail-keeper #11 (BUILD_RAILS.md): External-API chokepoint. Every
  // outbound HTTP from the platform routes through apps/api/src/external/.
  // Direct fetch() calls elsewhere are forbidden. The chokepoint absorbs
  // retries, rate-limit awareness, error normalization, and the required
  // emission-classification tag at every call site. Per-feature direct
  // HTTP calls would defeat the chokepoint's structural purpose.
  //
  // Scope: apps/api/src/** (the API surface).
  // Excluded: apps/api/src/external/ (the chokepoint itself uses fetch);
  //           apps/api/test/ (reachability probes for live-test gating).
  {
    files: ['apps/api/src/**/*.{ts,tsx}'],
    ignores: ['apps/api/src/external/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",
          message:
            'Direct fetch() is forbidden outside apps/api/src/external/. Route through the External-API chokepoint (rail-keeper #11). See BUILD_RAILS.md.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='globalThis'][callee.property.name='fetch']",
          message:
            'globalThis.fetch() is forbidden outside apps/api/src/external/. Route through the External-API chokepoint (rail-keeper #11). See BUILD_RAILS.md.',
        },
      ],
    },
  },
  // Node ESM scripts (workbench bootstrap etc.) — node globals, no browser.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
  },
  prettier,
);
