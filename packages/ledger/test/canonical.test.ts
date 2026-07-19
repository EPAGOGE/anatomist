import { describe, it, expect } from 'vitest';
import { attestation } from '@epagoge/crypto';
import type { AttestedEvent } from '@epagoge/shared';
import {
  computeEventHash,
  encodeSigningBytes,
  encodeFullEventBytes,
  toSigningPayload,
  verifyAttestation,
  signEvent,
} from '../src/canonical.js';

const validHash = (n: number) => n.toString(16).padStart(64, '0');

function basePayload() {
  return {
    version: 1 as const,
    chain_id: 'reasoning-capture',
    event_type: 'system-operational' as const,
    source_id: 'test-source',
    causal_predecessors: [validHash(0)],
    absence_set_delta: [],
    source_reliability: 65535,
    causal_sequence_marker: 1n,
    ground_truth_calibration_indicator: undefined,
    payload_integrity: validHash(1),
  };
}

describe('canonical encoding', () => {
  it('toSigningPayload strips attestation_signature', () => {
    const sigBytes = new Uint8Array([0x01]);
    const event: AttestedEvent = {
      ...basePayload(),
      attestation_signature: { pq: sigBytes, classical: sigBytes },
    };
    const stripped = toSigningPayload(event);
    expect(stripped).not.toHaveProperty('attestation_signature');
    expect(stripped.source_id).toBe('test-source');
  });

  it('encodeSigningBytes is independent of signature bytes', () => {
    const eventA: AttestedEvent = {
      ...basePayload(),
      attestation_signature: { pq: new Uint8Array([0x01]), classical: new Uint8Array([0x02]) },
    };
    const eventB: AttestedEvent = {
      ...basePayload(),
      attestation_signature: { pq: new Uint8Array([0xff]), classical: new Uint8Array([0xee]) },
    };
    expect(encodeSigningBytes(eventA)).toEqual(encodeSigningBytes(eventB));
  });

  it('encodeFullEventBytes IS dependent on signature bytes', () => {
    const eventA: AttestedEvent = {
      ...basePayload(),
      attestation_signature: { pq: new Uint8Array([0x01]), classical: new Uint8Array([0x02]) },
    };
    const eventB: AttestedEvent = {
      ...basePayload(),
      attestation_signature: { pq: new Uint8Array([0xff]), classical: new Uint8Array([0xee]) },
    };
    expect(encodeFullEventBytes(eventA)).not.toEqual(encodeFullEventBytes(eventB));
  });

  it('computeEventHash is deterministic', () => {
    const event: AttestedEvent = {
      ...basePayload(),
      attestation_signature: { pq: new Uint8Array([0x01]), classical: new Uint8Array([0x02]) },
    };
    const h1 = computeEventHash(event);
    const h2 = computeEventHash(event);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computeEventHash changes when any field changes', () => {
    const base = basePayload();
    const event: AttestedEvent = {
      ...base,
      attestation_signature: { pq: new Uint8Array([0x01]), classical: new Uint8Array([0x02]) },
    };
    const tampered: AttestedEvent = {
      ...base,
      source_id: 'different',
      attestation_signature: { pq: new Uint8Array([0x01]), classical: new Uint8Array([0x02]) },
    };
    expect(computeEventHash(event)).not.toBe(computeEventHash(tampered));
  });
});

describe('sign + verify roundtrip', () => {
  it('signEvent produces a verifiable AttestedEvent', async () => {
    const keys = await attestation.generateKeyPair();
    const event = await signEvent(basePayload(), {
      pq: keys.mldsa,
      classical: keys.ed25519,
    });

    expect(event.attestation_signature.pq.length).toBeGreaterThan(3000);
    expect(event.attestation_signature.classical.length).toBe(64);

    const ok = await verifyAttestation(event, {
      pq: keys.mldsa.publicKey,
      classical: keys.ed25519.publicKey,
    });
    expect(ok).toBe(true);
  });

  it('verifyAttestation rejects swapped keys', async () => {
    const keysA = await attestation.generateKeyPair();
    const keysB = await attestation.generateKeyPair();
    const event = await signEvent(basePayload(), {
      pq: keysA.mldsa,
      classical: keysA.ed25519,
    });

    const ok = await verifyAttestation(event, {
      pq: keysB.mldsa.publicKey,
      classical: keysB.ed25519.publicKey,
    });
    expect(ok).toBe(false);
  });

  it('verifyAttestation rejects tampered field', async () => {
    const keys = await attestation.generateKeyPair();
    const event = await signEvent(basePayload(), {
      pq: keys.mldsa,
      classical: keys.ed25519,
    });
    const tampered: AttestedEvent = { ...event, source_id: 'tampered' };
    const ok = await verifyAttestation(tampered, {
      pq: keys.mldsa.publicKey,
      classical: keys.ed25519.publicKey,
    });
    expect(ok).toBe(false);
  });
});
