// Auth-events chain payloads. Each auth-significant action — registration,
// login, logout, failed-login, api-key issued/revoked — gets an append-only
// chain event so the auth flow is itself audit-grade. Chain id: 'auth-events'.
// event_type is 'system-operational' because the platform records its own
// observation of auth activity; the chain is platform-owned (see ADR-0016).

import { z } from 'zod';

const ipString = z.string().min(1).max(64);
const userAgentString = z.string().max(512);

// `user_id` is included where a user is identified at the time the event is
// emitted. For failed-login on an unknown account, user_id is omitted; the
// chain still records the attempt without revealing whether the account
// existed.

export const AuthRegistrationSchema = z.object({
  kind: z.literal('auth-registration'),
  details: z.object({
    user_id: z.string().uuid(),
    source_id: z.string().min(1).max(255),
    email_lower: z.string().email(),
    ip: ipString,
    user_agent: userAgentString.optional(),
    occurred_at: z.string(),
  }),
});

export const AuthLoginSchema = z.object({
  kind: z.literal('auth-login'),
  details: z.object({
    user_id: z.string().uuid(),
    source_id: z.string().min(1).max(255),
    ip: ipString,
    user_agent: userAgentString.optional(),
    method: z.enum(['password', 'api-key']),
    occurred_at: z.string(),
  }),
});

export const AuthLoginFailedSchema = z.object({
  kind: z.literal('auth-login-failed'),
  details: z.object({
    email_lower: z.string().email().optional(),
    ip: ipString,
    user_agent: userAgentString.optional(),
    reason: z.enum(['invalid-credentials', 'rate-limited', 'malformed-request', 'unknown-account']),
    occurred_at: z.string(),
  }),
});

// F-0 Criterion 4 (ADR-0039) added these two failed-attempt events so
// that EVERY security-relevant state-changing attempt produces a signed
// chain record. The rate-limit chokepoint at the route layer
// (@fastify/rate-limit, 5/min/IP on auth routes) protects against
// flood from attackers; the chain record provides the auditable trail.

export const AuthRegistrationFailedSchema = z.object({
  kind: z.literal('auth-registration-failed'),
  details: z.object({
    email_lower: z.string().email().optional(),
    ip: ipString,
    user_agent: userAgentString.optional(),
    reason: z.enum(['email-already-exists', 'malformed-request', 'server-error']),
    occurred_at: z.string(),
  }),
});

export const AuthRefreshFailedSchema = z.object({
  kind: z.literal('auth-refresh-failed'),
  details: z.object({
    ip: ipString,
    user_agent: userAgentString.optional(),
    // The reason lets the audit distinguish "stolen-token reuse attempt"
    // (revoked) from "ordinary expiration" (expired) from "tampering"
    // (invalid-signature) from "client bug" (missing-jti / malformed).
    reason: z.enum(['invalid-signature', 'expired', 'revoked', 'missing-jti', 'malformed-request']),
    occurred_at: z.string(),
  }),
});

export const AuthLogoutSchema = z.object({
  kind: z.literal('auth-logout'),
  details: z.object({
    user_id: z.string().uuid(),
    refresh_token_uuid: z.string().uuid(),
    ip: ipString,
    occurred_at: z.string(),
  }),
});

export const AuthApiKeyIssuedSchema = z.object({
  kind: z.literal('auth-api-key-issued'),
  details: z.object({
    user_id: z.string().uuid(),
    api_key_id: z.string().uuid(),
    name: z.string().min(1).max(128),
    expires_at: z.string().optional(),
    occurred_at: z.string(),
  }),
});

export const AuthApiKeyRevokedSchema = z.object({
  kind: z.literal('auth-api-key-revoked'),
  details: z.object({
    user_id: z.string().uuid(),
    api_key_id: z.string().uuid(),
    occurred_at: z.string(),
  }),
});

export const AuthEventPayloadSchema = z.discriminatedUnion('kind', [
  AuthRegistrationSchema,
  AuthRegistrationFailedSchema,
  AuthLoginSchema,
  AuthLoginFailedSchema,
  AuthLogoutSchema,
  AuthRefreshFailedSchema,
  AuthApiKeyIssuedSchema,
  AuthApiKeyRevokedSchema,
]);

export type AuthEventPayload = z.infer<typeof AuthEventPayloadSchema>;
export type AuthRegistrationPayload = z.infer<typeof AuthRegistrationSchema>;
export type AuthRegistrationFailedPayload = z.infer<typeof AuthRegistrationFailedSchema>;
export type AuthLoginPayload = z.infer<typeof AuthLoginSchema>;
export type AuthLoginFailedPayload = z.infer<typeof AuthLoginFailedSchema>;
export type AuthLogoutPayload = z.infer<typeof AuthLogoutSchema>;
export type AuthRefreshFailedPayload = z.infer<typeof AuthRefreshFailedSchema>;
export type AuthApiKeyIssuedPayload = z.infer<typeof AuthApiKeyIssuedSchema>;
export type AuthApiKeyRevokedPayload = z.infer<typeof AuthApiKeyRevokedSchema>;
