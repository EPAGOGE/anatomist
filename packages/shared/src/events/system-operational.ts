// System-operational event payloads.
//
// A system-operational event records something that affected platform
// capability or state — server lifecycle, migration runs, configuration
// changes, doctor runs, error patterns. Routine operation noise (every
// HTTP request, every DB query, every API response) does NOT belong on
// this chain.
//
// Each payload is a discriminated union on `kind`. New kinds are added by
// ADR-driven extension; removal or rename requires schema versioning.

import { z } from 'zod';

export const ServerStartedSchema = z.object({
  kind: z.literal('server-started'),
  details: z.object({
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    node_version: z.string().min(1),
    pid: z.number().int().nonnegative(),
  }),
});

export const ServerStoppedSchema = z.object({
  kind: z.literal('server-stopped'),
  details: z.object({
    signal: z.string().min(1).optional(),
    uptime_seconds: z.number().nonnegative(),
  }),
});

export const MigrationAppliedSchema = z.object({
  kind: z.literal('migration-applied'),
  details: z.object({
    migration_tag: z.string().min(1),
    duration_ms: z.number().int().nonnegative(),
  }),
});

export const DoctorRunSchema = z.object({
  kind: z.literal('doctor-run'),
  details: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
  }),
});

export const ConfigurationChangedSchema = z.object({
  kind: z.literal('configuration-changed'),
  details: z.object({
    field: z.string().min(1),
    previous_value_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    new_value_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

// Genesis event for a user-primary chain. Emitted by the platform when a
// user registers; the chain's first event records the chain's existence
// with the user's identity and key fingerprints. See ADR-0013 + ADR-0015.
export const UserPrimaryGenesisSchema = z.object({
  kind: z.literal('user-primary-genesis'),
  details: z.object({
    user_id: z.string().uuid(),
    source_id: z.string().min(1).max(255),
    display_name: z.string().min(1).max(255),
    created_at: z.string(),
    public_key_fingerprints: z.object({
      pq_blake3: z.string().regex(/^[0-9a-f]{64}$/),
      classical_blake3: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
});

export const SystemOperationalPayloadSchema = z.discriminatedUnion('kind', [
  ServerStartedSchema,
  ServerStoppedSchema,
  MigrationAppliedSchema,
  DoctorRunSchema,
  ConfigurationChangedSchema,
  UserPrimaryGenesisSchema,
]);

export type SystemOperationalPayload = z.infer<typeof SystemOperationalPayloadSchema>;
export type ServerStartedPayload = z.infer<typeof ServerStartedSchema>;
export type ServerStoppedPayload = z.infer<typeof ServerStoppedSchema>;
export type MigrationAppliedPayload = z.infer<typeof MigrationAppliedSchema>;
export type DoctorRunPayload = z.infer<typeof DoctorRunSchema>;
export type ConfigurationChangedPayload = z.infer<typeof ConfigurationChangedSchema>;
export type UserPrimaryGenesisPayload = z.infer<typeof UserPrimaryGenesisSchema>;
