// Unit tests for the discipline wiring helpers in orchestrator.ts.
//
// These don't invoke Anthropic — they test the pieces of the discipline
// pipeline that are deterministic and runnable without an API key:
// system-prompt composition shape and feedback-turn structure.
//
// The full end-to-end (applyDiscipline=true through invokeAi to Anthropic
// and back through preflight) is covered by the doctor's cost-tracking
// roundtrip when ANTHROPIC_API_KEY is set.

import { describe, it, expect } from 'vitest';
import {
  PLATFORM_PHILOSOPHY,
  ROUTINE_RHYTHM,
  SUBSTANTIAL_RHYTHM,
  HERO_RHYTHM,
  formatRhythmGuidance,
  classifyResponse,
  preFlightCheck,
} from '@epagoge/ai';

describe('Discipline wiring — system prompt composition', () => {
  it('PLATFORM_PHILOSOPHY appears before rhythm guidance', () => {
    const philosophyIndex = 0;
    const rhythm = formatRhythmGuidance(SUBSTANTIAL_RHYTHM);

    const composed = [PLATFORM_PHILOSOPHY, rhythm, 'caller specific'].join('\n\n');
    expect(composed.indexOf(PLATFORM_PHILOSOPHY)).toBe(philosophyIndex);
    expect(composed.indexOf(rhythm)).toBeGreaterThan(
      composed.indexOf(PLATFORM_PHILOSOPHY) + PLATFORM_PHILOSOPHY.length,
    );
    expect(composed.indexOf('caller specific')).toBeGreaterThan(composed.indexOf(rhythm));
  });

  it('rhythm guidance scales structurally with response type', () => {
    const routine = formatRhythmGuidance(ROUTINE_RHYTHM);
    const substantial = formatRhythmGuidance(SUBSTANTIAL_RHYTHM);
    const hero = formatRhythmGuidance(HERO_RHYTHM);

    expect(routine).toContain('20-150 words');
    expect(substantial).toContain('150-800 words');
    expect(hero).toContain('300-1500 words');

    // Hero permits headers, routine does not.
    expect(hero).toContain('Headers permitted');
    expect(routine).toContain('No headers');
  });
});

describe('Discipline wiring — classification + preflight roundtrip', () => {
  it('hero classification on first interaction triggers full preflight', () => {
    const cls = classifyResponse({
      query: 'hi',
      isFirstInteraction: true,
      isFirstProjectMessage: false,
      projectStage: null,
      sessionLength: 0,
      queryComplexity: 'simple',
    });
    expect(cls).toBe('hero');
  });

  it('preFlightCheck on a hero response with anti-pattern recommends revise', () => {
    const result = preFlightCheck({
      query: 'walk me through this',
      draftResponse: 'Great question! Let me explain attention mechanisms...',
      responseType: 'hero',
    });
    expect(result.recommendation).toBe('revise');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.category).toBe('anti-pattern');
  });

  it('preFlightCheck on clean substantial response recommends send', () => {
    const result = preFlightCheck({
      query: 'how does attention scale with sequence length',
      draftResponse:
        'Standard attention scales quadratically with sequence length because each token computes ' +
        'weighted relevance against every other token. Linear attention variants approximate this ' +
        'with O(N) memory but lose some expressiveness.',
      responseType: 'substantial',
    });
    expect(result.recommendation).toBe('send');
    expect(result.issues).toEqual([]);
  });

  it('preflight on routine response demotes anti-pattern severity to minor', () => {
    const result = preFlightCheck({
      query: 'q',
      draftResponse: 'Great question! Answer.',
      responseType: 'routine',
    });
    const issue = result.issues.find((i) => i.category === 'anti-pattern');
    expect(issue?.severity).toBe('minor');
    // Minor issues alone don't trigger revise.
    expect(result.recommendation).toBe('send');
  });
});

describe('Discipline wiring — feedback turn structure', () => {
  // The buildPreflightFeedback function in orchestrator.ts is module-
  // private, but its output shape is reproducible: it's a bullet list of
  // issues followed by revision instructions. This test validates the
  // contract by checking the structure preFlightCheck → feedback meets.
  it('feedback string would carry per-issue severity + description', () => {
    // A draft that opens with "Great question!" trips GREAT_QUESTION,
    // and "good thinking" mid-response trips GOOD_THINKING. Both
    // patterns are catalogued as anti-patterns.
    const result = preFlightCheck({
      query: 'walk me through this',
      draftResponse: 'Great question! That was good thinking — here is the answer.',
      responseType: 'substantial',
    });
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of result.issues) {
      expect(['minor', 'significant', 'reject']).toContain(issue.severity);
      expect(issue.description.length).toBeGreaterThan(0);
    }
  });
});
