import { describe, it, expect } from 'vitest';
import {
  computeCost,
  nanosToUsd,
  usdToNanos,
  formatNanosUsd,
  MODELS,
  NANOS_PER_USD,
} from '../src/index.js';

describe('cost (known values)', () => {
  it('Opus 4.7: 1M input + 1M output = $30 = 30B nanoUSD', () => {
    const c = computeCost(MODELS.opus, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c.inputNanos).toBe(5_000_000_000n);
    expect(c.outputNanos).toBe(25_000_000_000n);
    expect(c.totalNanos).toBe(30_000_000_000n);
  });

  it('Sonnet 4.6: 1M input + 1M output = $18', () => {
    const c = computeCost(MODELS.sonnet, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c.totalNanos).toBe(18_000_000_000n);
  });

  it('Haiku 4.5: 1M input + 1M output = $6', () => {
    const c = computeCost(MODELS.haiku, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c.totalNanos).toBe(6_000_000_000n);
  });

  it('cache read discounts to 0.1x input', () => {
    const c = computeCost(MODELS.opus, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    expect(c.cacheReadNanos).toBe(500_000_000n); // $0.50
    expect(c.totalNanos).toBe(500_000_000n);
  });

  it('cache write 5m TTL is 1.25x input', () => {
    const c = computeCost(MODELS.opus, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheTtl: '5m',
    });
    expect(c.cacheWriteNanos).toBe(6_250_000_000n); // $6.25
  });

  it('cache write 1h TTL is 2x input', () => {
    const c = computeCost(MODELS.opus, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheTtl: '1h',
    });
    expect(c.cacheWriteNanos).toBe(10_000_000_000n); // $10
  });

  it('zero tokens produces zero nanos', () => {
    const c = computeCost(MODELS.opus, { inputTokens: 0, outputTokens: 0 });
    expect(c.totalNanos).toBe(0n);
  });

  it('round-trips nanos ↔ USD on integer dollar amounts', () => {
    expect(usdToNanos(1)).toBe(NANOS_PER_USD);
    expect(nanosToUsd(NANOS_PER_USD)).toBe(1);
    expect(usdToNanos(10)).toBe(10n * NANOS_PER_USD);
  });

  it('formatNanosUsd shows six decimals by default', () => {
    expect(formatNanosUsd(5_000_000_000n)).toBe('$5.000000');
    expect(formatNanosUsd(1_000n)).toBe('$0.000001'); // 1 microUSD
  });

  it('Haiku single-token cost rounds correctly', () => {
    // Haiku input = $1/MTok = 1000 nanoUSD/token.
    const c = computeCost(MODELS.haiku, { inputTokens: 1, outputTokens: 0 });
    expect(c.inputNanos).toBe(1_000n);
  });

  it('Opus single output token = 25000 nanoUSD', () => {
    const c = computeCost(MODELS.opus, { inputTokens: 0, outputTokens: 1 });
    expect(c.outputNanos).toBe(25_000n);
  });
});
