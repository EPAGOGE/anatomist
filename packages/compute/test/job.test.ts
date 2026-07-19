import { describe, it, expect } from 'vitest';
import { validateJobSpec, tripwireFromBudget, type TrainingJobSpec } from '../src/index.js';

const base: TrainingJobSpec = {
  name: 'demo-run',
  baseModel: 'gpt2',
  dataset: { uri: 'hf:stas/openwebtext-10k' },
  gpu: 'RTX_4090',
  hyperparams: { lr: 0.0003, epochs: 1 },
  limits: tripwireFromBudget({ maxUsd: 5, maxMinutes: 30 }),
  provider: 'runpod',
};

describe('validateJobSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateJobSpec(base)).toEqual([]);
  });

  it('rejects a missing cost cap — no job runs without a tripwire', () => {
    const bad: TrainingJobSpec = { ...base, limits: { ...base.limits, maxCostNanos: 0n } };
    const issues = validateJobSpec(bad);
    expect(issues.some((i) => i.field === 'limits.maxCostNanos')).toBe(true);
  });

  it('rejects a non-positive runtime cap', () => {
    const bad: TrainingJobSpec = { ...base, limits: { ...base.limits, maxRuntimeSeconds: 0 } };
    expect(validateJobSpec(bad).some((i) => i.field === 'limits.maxRuntimeSeconds')).toBe(true);
  });

  it('collects multiple issues (empty name + empty dataset)', () => {
    const issues = validateJobSpec({ ...base, name: '  ', dataset: { uri: '' } });
    expect(issues).toHaveLength(2);
  });
});
