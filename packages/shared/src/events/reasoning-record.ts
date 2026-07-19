// ReasoningRecord — payload schema for events on the reasoning-capture chain.
// See docs/adrs/0012-reasoning-capture-chain.md.
//
// Each architecturally-consequential decision (decision affecting multiple
// components, schema, library choice, API design, security model, performance
// trade-off, or anything a future maintainer might wonder "why was this done
// this way") produces a ReasoningRecord. The record is the CBOR-encoded
// payload of an AttestedEvent with chain_id='reasoning-capture' and
// event_type='system-operational'.
//
// Fields follow the EPAGOGE_Forward_Context.md schema verbatim.

import { z } from 'zod';

export const REVISABILITY = ['fixed', 'flexible', 'captured-optionality'] as const;
export type Revisability = (typeof REVISABILITY)[number];
export const RevisabilitySchema = z.enum(REVISABILITY);

export const REVIEWER_KIND = ['human', 'ai-self', 'human-and-ai'] as const;
export type ReviewerKind = (typeof REVIEWER_KIND)[number];

export const ReviewerAttestationSchema = z.object({
  kind: z.enum(REVIEWER_KIND),
  reviewer_id: z.string().min(1).max(255),
  // Optional free-text rationale for the attestation. Display only.
  note: z.string().max(2048).optional(),
});
export type ReviewerAttestation = z.infer<typeof ReviewerAttestationSchema>;

// Wall-clock decision date is metadata only — the chain's causal_sequence_marker
// is the authoritative ordering. The date here exists for human consumption.
// Stored as ISO-8601 string for CBOR portability across producers.
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;

export const ReasoningRecordSchema = z.object({
  decision_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, {
      message: 'decision_id must be ASCII alphanumeric / underscore / dash',
    }),
  decision_date: z.string().regex(ISO_DATE_REGEX, {
    message: 'decision_date must be ISO-8601 (YYYY-MM-DD or full timestamp)',
  }),
  decision_summary: z.string().min(1).max(280),
  alternatives_considered: z.array(z.string().min(1).max(1024)).default([]),
  trade_offs_weighed: z.array(z.string().min(1).max(1024)).default([]),
  reasoning: z.string().min(1).max(8192),
  future_implications: z.array(z.string().min(1).max(1024)).default([]),
  related_decisions: z.array(z.string().min(1).max(64)).default([]),
  implementation_location: z.array(z.string().min(1).max(512)).default([]),
  reviewer_attestation: ReviewerAttestationSchema,
  revisability: RevisabilitySchema,
});
export type ReasoningRecord = z.infer<typeof ReasoningRecordSchema>;
