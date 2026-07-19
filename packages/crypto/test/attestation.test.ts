import { describe, it, expect } from 'vitest';
import { attestation } from '../src/index.js';

const message = new TextEncoder().encode('hybrid attestation test payload');

describe('hybrid attestation', () => {
  it('roundtrip: attest then verify succeeds', async () => {
    const keys = await attestation.generateKeyPair();
    const sig = await attestation.attest(message, keys);

    expect(sig.pq).toBeInstanceOf(Uint8Array);
    expect(sig.classical).toBeInstanceOf(Uint8Array);
    expect(sig.classical.length).toBe(64);
    expect(sig.pq.length).toBeGreaterThan(3000);

    const ok = await attestation.verify(message, sig, {
      mldsa: keys.mldsa.publicKey,
      ed25519: keys.ed25519.publicKey,
    });
    expect(ok).toBe(true);
  });

  it('rejects tampered payload', async () => {
    const keys = await attestation.generateKeyPair();
    const sig = await attestation.attest(message, keys);

    const tampered = new Uint8Array(message);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    const ok = await attestation.verify(tampered, sig, {
      mldsa: keys.mldsa.publicKey,
      ed25519: keys.ed25519.publicKey,
    });
    expect(ok).toBe(false);
  });

  it('rejects when only the pq signature is corrupted', async () => {
    const keys = await attestation.generateKeyPair();
    const sig = await attestation.attest(message, keys);
    const corruptedPq = new Uint8Array(sig.pq);
    corruptedPq[0] = (corruptedPq[0] ?? 0) ^ 0xff;

    const ok = await attestation.verify(
      message,
      { pq: corruptedPq, classical: sig.classical },
      { mldsa: keys.mldsa.publicKey, ed25519: keys.ed25519.publicKey },
    );
    expect(ok).toBe(false);
  });

  it('rejects when only the classical signature is corrupted', async () => {
    const keys = await attestation.generateKeyPair();
    const sig = await attestation.attest(message, keys);
    const corruptedClassical = new Uint8Array(sig.classical);
    corruptedClassical[0] = (corruptedClassical[0] ?? 0) ^ 0xff;

    const ok = await attestation.verify(
      message,
      { pq: sig.pq, classical: corruptedClassical },
      { mldsa: keys.mldsa.publicKey, ed25519: keys.ed25519.publicKey },
    );
    expect(ok).toBe(false);
  });

  it('rejects signatures from a different keypair', async () => {
    const keysA = await attestation.generateKeyPair();
    const keysB = await attestation.generateKeyPair();
    const sigA = await attestation.attest(message, keysA);

    const ok = await attestation.verify(message, sigA, {
      mldsa: keysB.mldsa.publicKey,
      ed25519: keysB.ed25519.publicKey,
    });
    expect(ok).toBe(false);
  });

  it('mismatched public keys per algorithm: pq right, classical wrong', async () => {
    const keysA = await attestation.generateKeyPair();
    const keysB = await attestation.generateKeyPair();
    const sigA = await attestation.attest(message, keysA);

    const ok = await attestation.verify(message, sigA, {
      mldsa: keysA.mldsa.publicKey,
      ed25519: keysB.ed25519.publicKey,
    });
    expect(ok).toBe(false);
  });

  it('mismatched public keys per algorithm: classical right, pq wrong', async () => {
    const keysA = await attestation.generateKeyPair();
    const keysB = await attestation.generateKeyPair();
    const sigA = await attestation.attest(message, keysA);

    const ok = await attestation.verify(message, sigA, {
      mldsa: keysB.mldsa.publicKey,
      ed25519: keysA.ed25519.publicKey,
    });
    expect(ok).toBe(false);
  });
});
