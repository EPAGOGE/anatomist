// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { blake3, ed25519, mldsa } from '../src/index.js';

const message = new TextEncoder().encode('reliability-weighted inference verify');

describe('attestation primitives (node environment, coverage path)', () => {
  it('BLAKE3 produces 32-byte digest', () => {
    const digest = blake3.hash(message);
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
  });

  it('Ed25519 signs, verifies, rejects tampering', async () => {
    const kp = await ed25519.generateKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(64);

    const sig = await ed25519.sign(message, kp.secretKey);
    expect(sig.length).toBe(64);
    expect(await ed25519.verify(sig, message, kp.publicKey)).toBe(true);

    const tampered = new Uint8Array(message);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(await ed25519.verify(sig, tampered, kp.publicKey)).toBe(false);
  });

  it('Ed25519 ready() resolves once and is reusable', async () => {
    await ed25519.ready();
    await ed25519.ready();
    expect(true).toBe(true);
  });

  it('ML-DSA-65 signs, verifies, rejects tampering', async () => {
    const kp = await mldsa.generateKeyPair();
    expect(kp.publicKey.length).toBe(1952);
    expect(kp.secretKey.length).toBe(4032);

    const sig = await mldsa.sign(message, kp.secretKey);
    expect(sig.length).toBeGreaterThan(3000);
    expect(sig.length).toBeLessThan(3500);
    expect(await mldsa.verify(message, sig, kp.publicKey)).toBe(true);

    const tampered = new Uint8Array(message);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(await mldsa.verify(tampered, sig, kp.publicKey)).toBe(false);
  });
});
