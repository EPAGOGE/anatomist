import { z } from 'zod';
import type { Brand } from './brand.js';

export type UserId = Brand<string, 'UserId'>;

export const UserIdSchema = z.string().uuid().brand<'UserId'>();

// Four-layer topology roles. A single process may host any subset of these
// in development; production deployments separate them across machines.
// See docs/adrs/0007-event-ordering.md for the broader topology context.
export const NODE_ROLES = ['node', 'supernode', 'investigator', 'tower'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

export const NodeRoleSchema = z.enum(NODE_ROLES);

export const UserSchema = z.object({
  id: UserIdSchema,
  source_id: z.string().min(1).max(255),
  display_name: z.string().min(1).max(255),
  role: NodeRoleSchema,
  attestation_public_key_pq: z.instanceof(Uint8Array),
  attestation_public_key_classical: z.instanceof(Uint8Array),
});
export type User = z.infer<typeof UserSchema>;
