import { describe, it, expect } from 'vitest';
import {
  PLATFORM_PHILOSOPHY,
  applyPlatformVoice,
  classifyResponse,
  estimateQueryComplexity,
  preFlightCheck,
  ANTI_PATTERNS,
  checkSubstance,
  checkCalibration,
  ROUTINE_RHYTHM,
  SUBSTANTIAL_RHYTHM,
  HERO_RHYTHM,
  formatRhythmGuidance,
  formatReferencesForPrompt,
} from '../src/index.js';

describe('Platform Philosophy', () => {
  it('declares anti-patterns to refuse', () => {
    expect(PLATFORM_PHILOSOPHY).toContain('ANTI-PATTERNS');
    expect(PLATFORM_PHILOSOPHY).toContain('Generic motivational');
    expect(PLATFORM_PHILOSOPHY).toContain('Sycophantic praise');
  });

  it('declares voice principles', () => {
    expect(PLATFORM_PHILOSOPHY).toContain('VOICE:');
    expect(PLATFORM_PHILOSOPHY).toContain('Honest about uncertainty');
  });

  it('applyPlatformVoice prepends the philosophy to task prompts', () => {
    const applied = applyPlatformVoice('Generate code for a transformer');
    expect(applied.startsWith(PLATFORM_PHILOSOPHY)).toBe(true);
    expect(applied).toContain('Generate code for a transformer');
    expect(applied).toContain('TASK CONTEXT:');
  });
});

describe('Response Type Classification', () => {
  it('classifies first interactions as hero regardless of query simplicity', () => {
    const result = classifyResponse({
      query: 'hello',
      isFirstInteraction: true,
      isFirstProjectMessage: false,
      projectStage: null,
      sessionLength: 0,
      queryComplexity: 'simple',
    });
    expect(result).toBe('hero');
  });

  it('classifies first project messages as hero', () => {
    const result = classifyResponse({
      query: 'set up the data pipeline',
      isFirstInteraction: false,
      isFirstProjectMessage: true,
      projectStage: 'data',
      sessionLength: 0,
      queryComplexity: 'moderate',
    });
    expect(result).toBe('hero');
  });

  it('classifies simple queries as routine', () => {
    const result = classifyResponse({
      query: 'how do I import torch',
      isFirstInteraction: false,
      isFirstProjectMessage: false,
      projectStage: null,
      sessionLength: 5,
      queryComplexity: 'simple',
    });
    expect(result).toBe('routine');
  });

  it('classifies complex queries as substantial', () => {
    const result = classifyResponse({
      query: 'how should I architect attention mechanisms for very long sequences',
      isFirstInteraction: false,
      isFirstProjectMessage: false,
      projectStage: 'architecture',
      sessionLength: 10,
      queryComplexity: 'complex',
    });
    expect(result).toBe('substantial');
  });

  it('classifies moderate queries in architecture stage as substantial', () => {
    const result = classifyResponse({
      query: 'should I use ReLU or GELU here',
      isFirstInteraction: false,
      isFirstProjectMessage: false,
      projectStage: 'architecture',
      sessionLength: 10,
      queryComplexity: 'moderate',
    });
    expect(result).toBe('substantial');
  });

  it('escalates to substantial after a long session of moderate queries', () => {
    const result = classifyResponse({
      query: 'walk me through this batch norm consideration',
      isFirstInteraction: false,
      isFirstProjectMessage: false,
      projectStage: null,
      sessionLength: 25,
      queryComplexity: 'moderate',
    });
    expect(result).toBe('substantial');
  });
});

describe('Query Complexity Estimation', () => {
  it('classifies short factual queries as simple', () => {
    expect(estimateQueryComplexity('what is a tensor')).toBe('simple');
  });

  it('classifies architectural questions as moderate or complex', () => {
    const result = estimateQueryComplexity(
      'how should I design the attention layer for efficiency',
    );
    expect(['moderate', 'complex']).toContain(result);
  });

  it('classifies multi-question queries as moderate or complex', () => {
    const result = estimateQueryComplexity('what is X? and how does it relate to Y?');
    expect(['moderate', 'complex']).toContain(result);
  });

  it('classifies long context-laden queries as complex', () => {
    const longQuery =
      'I am working on a transformer architecture for long-context understanding. ' +
      'I have considered several approaches including sliding window attention, sparse attention, ' +
      'and various forms of grouped attention. What architectural tradeoffs should I consider when ' +
      'choosing between these approaches for a model that needs to handle 100k token contexts?';
    expect(estimateQueryComplexity(longQuery)).toBe('complex');
  });
});

describe('Anti-Pattern Detection', () => {
  it('flags "Great question!" opening', () => {
    const result = preFlightCheck({
      query: 'how does attention work',
      draftResponse: 'Great question! Attention is a mechanism...',
      responseType: 'routine',
    });
    expect(result.issues.some((i) => i.category === 'anti-pattern')).toBe(true);
  });

  it('flags "What a fascinating idea!" opening', () => {
    const result = preFlightCheck({
      query: 'consider this idea',
      draftResponse: 'What a fascinating idea! Let me explore...',
      responseType: 'substantial',
    });
    expect(result.issues.some((i) => i.category === 'anti-pattern')).toBe(true);
  });

  it('flags sycophantic praise', () => {
    const result = preFlightCheck({
      query: 'is this approach reasonable',
      draftResponse: "That's a clever approach! Here's the analysis.",
      responseType: 'substantial',
    });
    expect(result.issues.some((i) => i.category === 'anti-pattern')).toBe(true);
  });

  it('accepts substantive openings without anti-patterns', () => {
    const result = preFlightCheck({
      query: 'how does attention work',
      draftResponse: 'Attention computes weighted relevance between elements in a sequence.',
      responseType: 'routine',
    });
    expect(result.issues.some((i) => i.category === 'anti-pattern')).toBe(false);
    expect(result.recommendation).toBe('send');
  });

  it('escalates severity from minor → significant for non-routine responses', () => {
    const draft = 'Great question! Here is the answer.';
    const routine = preFlightCheck({
      query: 'q',
      draftResponse: draft,
      responseType: 'routine',
    });
    const hero = preFlightCheck({ query: 'q', draftResponse: draft, responseType: 'hero' });
    const routineSev = routine.issues.find((i) => i.category === 'anti-pattern')?.severity;
    const heroSev = hero.issues.find((i) => i.category === 'anti-pattern')?.severity;
    expect(routineSev).toBe('minor');
    expect(heroSev).toBe('significant');
  });

  it('catalogues the expected anti-patterns', () => {
    // Spot-check that the catalogue covers the explicit examples in the
    // platform philosophy.
    expect(Object.keys(ANTI_PATTERNS)).toEqual(
      expect.arrayContaining([
        'GREAT_QUESTION',
        'WHAT_A',
        'ABSOLUTELY',
        'CLEVER_APPROACH',
        'IN_CONCLUSION',
      ]),
    );
  });
});

describe('Substance + Calibration Checks', () => {
  it('flags responses that are mostly disclaimers', () => {
    const draft =
      "I'm an AI and I cannot give legal advice. I'm just a language model. " +
      'Please consult a professional.';
    const issues = checkSubstance('explain this to me', draft);
    expect(issues.some((i) => i.category === 'substance' && i.severity === 'reject')).toBe(true);
  });

  it('flags responses substantially shorter than the query', () => {
    const longQuery = 'q'.repeat(200);
    const shortReply = 'r'.repeat(50);
    const issues = checkSubstance(longQuery, shortReply);
    expect(issues.some((i) => i.category === 'substance')).toBe(true);
  });

  it('flags overconfident absolute claims', () => {
    const draft =
      'This is always the case. It is impossible to use a different approach. ' +
      'This must work and cannot fail.';
    const issues = checkCalibration(draft);
    expect(issues.some((i) => i.category === 'calibration')).toBe(true);
  });

  it('routine responses skip substance + calibration checks', () => {
    // A short response to a long query would flag substance, but only for
    // non-routine response types.
    const result = preFlightCheck({
      query: 'q'.repeat(200),
      draftResponse: 'short',
      responseType: 'routine',
    });
    expect(result.issues.some((i) => i.category === 'substance')).toBe(false);
  });
});

describe('Pre-flight Recommendations', () => {
  it('recommends "send" when no issues', () => {
    const result = preFlightCheck({
      query: 'what is a tensor',
      draftResponse: 'A tensor is a multi-dimensional array used in numerical computing.',
      responseType: 'routine',
    });
    expect(result.recommendation).toBe('send');
    expect(result.passed).toBe(true);
  });

  it('recommends "regenerate" on reject-severity issues', () => {
    const draft =
      "I'm an AI and I cannot help. I'm just a language model. Please consult a professional.";
    const result = preFlightCheck({
      query: 'q'.repeat(200),
      draftResponse: draft,
      responseType: 'substantial',
    });
    expect(result.recommendation).toBe('regenerate');
    expect(result.passed).toBe(false);
  });

  it('recommends "revise" on significant (non-reject) issues', () => {
    const result = preFlightCheck({
      query: 'walk through this',
      draftResponse: 'Great question! Here is the answer.',
      responseType: 'hero',
    });
    expect(result.recommendation).toBe('revise');
  });
});

describe('Response Rhythm Profiles', () => {
  it('ROUTINE_RHYTHM is short prose only', () => {
    expect(ROUTINE_RHYTHM.targetWordCount.max).toBeLessThanOrEqual(200);
    expect(ROUTINE_RHYTHM.allowedHeaders).toBe(false);
    expect(ROUTINE_RHYTHM.preferredStructure).toBe('prose');
  });

  it('SUBSTANTIAL_RHYTHM permits mixed structure', () => {
    expect(SUBSTANTIAL_RHYTHM.allowedBullets).toBe(true);
    expect(SUBSTANTIAL_RHYTHM.preferredStructure).toBe('mixed');
  });

  it('HERO_RHYTHM allows the longest band + headers', () => {
    expect(HERO_RHYTHM.targetWordCount.max).toBeGreaterThan(SUBSTANTIAL_RHYTHM.targetWordCount.max);
    expect(HERO_RHYTHM.allowedHeaders).toBe(true);
    expect(HERO_RHYTHM.warmth).toBe('warm');
  });

  it('formatRhythmGuidance emits a usable system-prompt fragment', () => {
    const guidance = formatRhythmGuidance(SUBSTANTIAL_RHYTHM);
    expect(guidance).toContain('RESPONSE RHYTHM:');
    expect(guidance).toContain('150-800 words');
    expect(guidance).toContain('Length scales to substance');
  });
});

describe('Reference Formatter', () => {
  it('returns empty string when references are empty', () => {
    const out = formatReferencesForPrompt({
      projectContext: null,
      recentDecisions: [],
      chainHistory: [],
      sessionContext: [],
    });
    expect(out).toBe('');
  });

  it('formats project context when present', () => {
    const out = formatReferencesForPrompt({
      projectContext: {
        projectId: 'p1',
        projectName: 'sample-proj',
        lifecyclePosition: 'architecture',
        purpose: 'demo',
        recentActivity: ['decided ReLU', 'set lr to 3e-4'],
      },
      recentDecisions: [],
      chainHistory: [],
      sessionContext: [],
    });
    expect(out).toContain('PROJECT CONTEXT');
    expect(out).toContain('sample-proj');
    expect(out).toContain('architecture');
  });
});
