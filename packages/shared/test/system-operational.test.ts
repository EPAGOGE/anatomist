import { describe, it, expect } from 'vitest';
import {
  SystemOperationalPayloadSchema,
  ServerStartedSchema,
  ServerStoppedSchema,
  MigrationAppliedSchema,
  DoctorRunSchema,
  ConfigurationChangedSchema,
} from '../src/events/system-operational.js';

describe('SystemOperationalPayload — discriminated union', () => {
  it('accepts a server-started payload', () => {
    const ok = SystemOperationalPayloadSchema.safeParse({
      kind: 'server-started',
      details: {
        host: '0.0.0.0',
        port: 3000,
        node_version: '24.15.0',
        pid: 12345,
      },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a server-stopped payload with optional signal', () => {
    expect(
      SystemOperationalPayloadSchema.safeParse({
        kind: 'server-stopped',
        details: { uptime_seconds: 42.5 },
      }).success,
    ).toBe(true);
    expect(
      SystemOperationalPayloadSchema.safeParse({
        kind: 'server-stopped',
        details: { signal: 'SIGTERM', uptime_seconds: 0 },
      }).success,
    ).toBe(true);
  });

  it('accepts a migration-applied payload', () => {
    expect(
      SystemOperationalPayloadSchema.safeParse({
        kind: 'migration-applied',
        details: { migration_tag: '0001_payload_inline', duration_ms: 250 },
      }).success,
    ).toBe(true);
  });

  it('accepts a doctor-run payload', () => {
    expect(
      SystemOperationalPayloadSchema.safeParse({
        kind: 'doctor-run',
        details: { passed: 17, failed: 0, skipped: 0, duration_ms: 215 },
      }).success,
    ).toBe(true);
  });

  it('accepts a configuration-changed payload (with optional previous hash)', () => {
    const hash = 'a'.repeat(64);
    expect(
      SystemOperationalPayloadSchema.safeParse({
        kind: 'configuration-changed',
        details: { field: 'RATE_LIMIT_MAX', new_value_hash: hash },
      }).success,
    ).toBe(true);
    expect(
      SystemOperationalPayloadSchema.safeParse({
        kind: 'configuration-changed',
        details: { field: 'X', previous_value_hash: hash, new_value_hash: hash },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(
      SystemOperationalPayloadSchema.safeParse({
        kind: 'banana',
        details: {},
      }).success,
    ).toBe(false);
  });

  it('rejects missing required details fields', () => {
    expect(
      ServerStartedSchema.safeParse({
        kind: 'server-started',
        details: { host: 'h', port: 1, node_version: '24' /* missing pid */ },
      }).success,
    ).toBe(false);
  });

  it('rejects out-of-range port', () => {
    expect(
      ServerStartedSchema.safeParse({
        kind: 'server-started',
        details: { host: 'h', port: 70000, node_version: '24', pid: 1 },
      }).success,
    ).toBe(false);
  });

  it('rejects negative uptime', () => {
    expect(
      ServerStoppedSchema.safeParse({
        kind: 'server-stopped',
        details: { uptime_seconds: -1 },
      }).success,
    ).toBe(false);
  });

  it('rejects non-hex previous_value_hash', () => {
    expect(
      ConfigurationChangedSchema.safeParse({
        kind: 'configuration-changed',
        details: { field: 'X', new_value_hash: 'not-hex' },
      }).success,
    ).toBe(false);
  });

  it('rejects non-integer duration_ms in doctor-run', () => {
    expect(
      DoctorRunSchema.safeParse({
        kind: 'doctor-run',
        details: { passed: 0, failed: 0, skipped: 0, duration_ms: 1.5 },
      }).success,
    ).toBe(false);
  });

  it('rejects empty migration_tag', () => {
    expect(
      MigrationAppliedSchema.safeParse({
        kind: 'migration-applied',
        details: { migration_tag: '', duration_ms: 1 },
      }).success,
    ).toBe(false);
  });
});
