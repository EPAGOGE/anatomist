import { describe, it, expect } from 'vitest';
import { UserSchema, UserIdSchema, NodeRoleSchema, NODE_ROLES } from '../src/types/user.js';

describe('NodeRole / NODE_ROLES', () => {
  it('exports the four roles in stable order', () => {
    expect(NODE_ROLES).toEqual(['node', 'supernode', 'investigator', 'tower']);
  });

  it('NodeRoleSchema accepts each role', () => {
    for (const role of NODE_ROLES) {
      expect(() => NodeRoleSchema.parse(role)).not.toThrow();
    }
  });

  it('NodeRoleSchema rejects unknown role', () => {
    expect(() => NodeRoleSchema.parse('admin')).toThrow();
    expect(() => NodeRoleSchema.parse('')).toThrow();
    expect(() => NodeRoleSchema.parse(undefined)).toThrow();
  });
});

describe('UserSchema', () => {
  const validUuid = '00000000-0000-4000-8000-000000000001';

  it('accepts a complete User', () => {
    expect(() =>
      UserSchema.parse({
        id: validUuid,
        source_id: 'src-1',
        display_name: 'Test User',
        role: 'node',
        attestation_public_key_pq: new Uint8Array([0x01]),
        attestation_public_key_classical: new Uint8Array([0x02]),
      }),
    ).not.toThrow();
  });

  it('rejects non-UUID id', () => {
    expect(() =>
      UserSchema.parse({
        id: 'not-a-uuid',
        source_id: 'src-1',
        display_name: 'Test',
        role: 'node',
        attestation_public_key_pq: new Uint8Array(),
        attestation_public_key_classical: new Uint8Array(),
      }),
    ).toThrow();
  });

  it('rejects unknown role', () => {
    expect(() =>
      UserSchema.parse({
        id: validUuid,
        source_id: 'src-1',
        display_name: 'Test',
        role: 'admin',
        attestation_public_key_pq: new Uint8Array(),
        attestation_public_key_classical: new Uint8Array(),
      }),
    ).toThrow();
  });

  it('UserIdSchema accepts valid UUIDs', () => {
    expect(() => UserIdSchema.parse(validUuid)).not.toThrow();
    expect(() => UserIdSchema.parse('not-uuid')).toThrow();
  });
});
