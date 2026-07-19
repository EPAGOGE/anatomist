import { describe, it, expect } from 'vitest';
import {
  RunPodProvider,
  RUNPOD_GPU_TYPE_IDS,
  tripwireFromBudget,
  type TrainingJobSpec,
} from '../src/index.js';

const spec: TrainingJobSpec = {
  name: 'x',
  baseModel: 'gpt2',
  dataset: { uri: 'hf:demo' },
  gpu: 'A100_80GB',
  hyperparams: {},
  limits: tripwireFromBudget({ maxUsd: 5, maxMinutes: 30 }),
  provider: 'runpod',
};

/** A fetch stub returning one live price for the A100 80GB gpuTypeId. */
function pricedFetch(price: number) {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: {
            gpuTypes: [
              { id: RUNPOD_GPU_TYPE_IDS.A100_80GB, lowestPrice: { uninterruptablePrice: price } },
            ],
          },
        }),
    });
}

describe('RunPodProvider pricing', () => {
  it('uses the live price when available (reference: false)', async () => {
    const p = new RunPodProvider({ apiKey: 'k', fetchImpl: pricedFetch(1.99) });
    const est = await p.estimateCost(spec, 2);
    expect(est.reference).toBe(false);
    expect(est.computeNanos).toBe(3_980_000_000n); // $1.99 * 2h
  });

  it('overlays live prices onto the catalog in listGpus', async () => {
    const p = new RunPodProvider({ apiKey: 'k', fetchImpl: pricedFetch(1.23) });
    const gpus = await p.listGpus();
    expect(gpus.find((g) => g.id === 'A100_80GB')?.referenceUsdPerHour).toBe(1.23);
    // a GPU with no live entry keeps its reference price
    expect(gpus.find((g) => g.id === 'RTX_4090')?.referenceUsdPerHour).toBe(0.69);
  });

  it('falls back to reference prices with no API key (reference: true)', async () => {
    const p = new RunPodProvider();
    const est = await p.estimateCost(spec, 1);
    expect(est.reference).toBe(true);
  });

  it('falls back to reference on a non-200 response', async () => {
    const failing = () =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const p = new RunPodProvider({ apiKey: 'k', fetchImpl: failing });
    expect((await p.estimateCost(spec, 1)).reference).toBe(true);
  });
});

describe('RunPodProvider provisioning guards', () => {
  it('refuses to provision a spec with no cost cap', async () => {
    const p = new RunPodProvider({ apiKey: 'k' });
    const bad: TrainingJobSpec = { ...spec, limits: { ...spec.limits, maxCostNanos: 0n } };
    await expect(p.provision(bad)).rejects.toThrow(/invalid job spec/);
  });

  it('requires an API key even for a valid spec', async () => {
    const p = new RunPodProvider();
    await expect(p.provision(spec)).rejects.toThrow(/RUNPOD_API_KEY/);
  });
});
