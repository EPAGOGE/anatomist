import { describe, it, expect } from 'vitest';
import {
  ReasoningRecordSchema,
  ReviewerAttestationSchema,
  RevisabilitySchema,
  REVISABILITY,
  type ReasoningRecord,
} from '../src/events/reasoning-record.js';

const validRecord = (overrides: Partial<ReasoningRecord> = {}): ReasoningRecord => ({
  decision_id: 'ADR-0001',
  decision_date: '2026-05-19',
  decision_summary: 'Use TypeScript 5.6 LTS for the monorepo',
  alternatives_considered: ['TypeScript 6.0', 'TypeScript 5.5'],
  trade_offs_weighed: ['ecosystem tooling compatibility', 'feature availability'],
  reasoning: 'TS 6 has deprecated options ecosystem tools still rely on.',
  future_implications: ['can revisit when typescript-eslint announces TS 6 support'],
  related_decisions: ['ADR-0002', 'ADR-0006'],
  implementation_location: ['package.json', 'tsconfig.base.json'],
  reviewer_attestation: {
    kind: 'ai-self',
    reviewer_id: 'claude-code-session',
  },
  revisability: 'flexible',
  ...overrides,
});

describe('ReasoningRecord — schema validation', () => {
  it('accepts a minimal valid record', () => {
    expect(() => ReasoningRecordSchema.parse(validRecord())).not.toThrow();
  });

  it('accepts ISO-8601 date with full timestamp', () => {
    expect(() =>
      ReasoningRecordSchema.parse(validRecord({ decision_date: '2026-05-19T16:43:22Z' })),
    ).not.toThrow();
    expect(() =>
      ReasoningRecordSchema.parse(validRecord({ decision_date: '2026-05-19T16:43:22.123-06:00' })),
    ).not.toThrow();
  });

  it('rejects non-ISO date', () => {
    expect(() =>
      ReasoningRecordSchema.parse(validRecord({ decision_date: '05/19/2026' })),
    ).toThrow();
    expect(() =>
      ReasoningRecordSchema.parse(validRecord({ decision_date: 'yesterday' })),
    ).toThrow();
  });

  it('rejects invalid decision_id characters', () => {
    expect(() => ReasoningRecordSchema.parse(validRecord({ decision_id: 'ADR 0001' }))).toThrow();
    expect(() => ReasoningRecordSchema.parse(validRecord({ decision_id: 'adr/0001' }))).toThrow();
    expect(() => ReasoningRecordSchema.parse(validRecord({ decision_id: '' }))).toThrow();
  });

  it('rejects empty decision_summary', () => {
    expect(() => ReasoningRecordSchema.parse(validRecord({ decision_summary: '' }))).toThrow();
  });

  it('rejects oversized summary', () => {
    expect(() =>
      ReasoningRecordSchema.parse(validRecord({ decision_summary: 'x'.repeat(281) })),
    ).toThrow();
  });

  it('rejects empty reasoning', () => {
    expect(() => ReasoningRecordSchema.parse(validRecord({ reasoning: '' }))).toThrow();
  });

  it('accepts empty alternatives / trade-offs / future implications arrays', () => {
    expect(() =>
      ReasoningRecordSchema.parse(
        validRecord({
          alternatives_considered: [],
          trade_offs_weighed: [],
          future_implications: [],
        }),
      ),
    ).not.toThrow();
  });
});

describe('ReviewerAttestation', () => {
  it('accepts each reviewer kind', () => {
    for (const kind of ['human', 'ai-self', 'human-and-ai'] as const) {
      expect(() => ReviewerAttestationSchema.parse({ kind, reviewer_id: 'someone' })).not.toThrow();
    }
  });

  it('rejects unknown reviewer kind', () => {
    expect(() => ReviewerAttestationSchema.parse({ kind: 'robot', reviewer_id: 'r' })).toThrow();
  });

  it('accepts optional note', () => {
    expect(() =>
      ReviewerAttestationSchema.parse({
        kind: 'human',
        reviewer_id: 'jth',
        note: 'reviewed in person',
      }),
    ).not.toThrow();
  });
});

describe('Revisability', () => {
  it('exports the three values', () => {
    expect(REVISABILITY).toEqual(['fixed', 'flexible', 'captured-optionality']);
  });

  it('rejects unknown value', () => {
    expect(() => RevisabilitySchema.parse('eventually')).toThrow();
  });
});
