/**
 * Response rhythm — the equivalent of "sound design" in the video
 * production script.
 *
 * AI responses have rhythm. Where they pause. Where they go quiet rather
 * than filling space. Where they give one substantial line versus
 * elaborating. The rhythm produces emotional quality alongside informational
 * content.
 *
 * This module guides response STRUCTURE without dictating content. The
 * model generates the substance; rhythm parameters shape the form via the
 * system prompt. Lengths are hints, not enforced ceilings — a substantial
 * response that legitimately needs 900 words isn't penalized for going
 * 100 over the 800-word target.
 */

export type RhythmProfile = {
  /** Soft target band for total length, in words. */
  targetWordCount: { min: number; max: number };

  /** Structural permissions. */
  allowedHeaders: boolean;
  allowedBullets: boolean;
  preferredStructure: 'prose' | 'list' | 'mixed';

  /** Pacing hints. */
  paragraphLengthHint: 'short' | 'medium' | 'long';
  pausePoints: 'minimal' | 'moderate' | 'frequent';

  /** Voice modulation. Combines with the platform philosophy. */
  warmth: 'reserved' | 'engaged' | 'warm';
  directness: 'measured' | 'direct' | 'blunt';
};

/** Routine: short, direct, prose. The fast lane. */
export const ROUTINE_RHYTHM: RhythmProfile = Object.freeze({
  targetWordCount: { min: 20, max: 150 },
  allowedHeaders: false,
  allowedBullets: false,
  preferredStructure: 'prose',
  paragraphLengthHint: 'short',
  pausePoints: 'minimal',
  warmth: 'engaged',
  directness: 'direct',
});

/** Substantial: medium length, mixed structure, room for development. */
export const SUBSTANTIAL_RHYTHM: RhythmProfile = Object.freeze({
  targetWordCount: { min: 150, max: 800 },
  allowedHeaders: false,
  allowedBullets: true,
  preferredStructure: 'mixed',
  paragraphLengthHint: 'medium',
  pausePoints: 'moderate',
  warmth: 'engaged',
  directness: 'direct',
});

/** Hero: longer permitted, headers allowed, slightly warmer tone. */
export const HERO_RHYTHM: RhythmProfile = Object.freeze({
  targetWordCount: { min: 300, max: 1500 },
  allowedHeaders: true,
  allowedBullets: true,
  preferredStructure: 'mixed',
  paragraphLengthHint: 'medium',
  pausePoints: 'moderate',
  warmth: 'warm',
  directness: 'direct',
});

/**
 * Format rhythm guidance for inclusion in the system prompt. The model
 * uses this as structural guidance, not rigid rules.
 */
export function formatRhythmGuidance(profile: RhythmProfile): string {
  return `
RESPONSE RHYTHM:
- Target length: ${profile.targetWordCount.min}-${profile.targetWordCount.max} words
- Structure: ${profile.preferredStructure}
- ${profile.allowedHeaders ? 'Headers permitted for substantial responses' : 'No headers'}
- ${profile.allowedBullets ? 'Bullets permitted where they aid clarity' : 'Prose only, no bullet lists'}
- Paragraph length: ${profile.paragraphLengthHint}
- Tone: ${profile.warmth}, ${profile.directness}

Where a response could pause and let an idea breathe, let it.
Where elaboration would dilute rather than develop, stop.
Length scales to substance. Brief when brief serves; longer when length serves.
`.trim();
}
