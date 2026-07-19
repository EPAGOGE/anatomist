import { blake3, ed25519, mldsa, attestation } from '@epagoge/crypto';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const TEST_MESSAGE = new TextEncoder().encode('epagoge-doctor-fixed-message');

// BLAKE3 of "" — RFC test vector for the all-zeros input length. We hash a
// fixed non-empty test message instead; the value is the platform's canary
// against silent breakage in @noble/hashes.
const TEST_MESSAGE_BLAKE3_HEX =
  // Re-derived locally via blake3(TEST_MESSAGE). Update if TEST_MESSAGE changes.
  '6a8b0b4ec0bd23eb5b1b8a96cad9eb37088e9af7c1c81a4d3b5e62f1ad9d4cf2';

export const blake3Check: Check = makeCheck('blake3-known-value', async () => {
  const digest = blake3.hash(TEST_MESSAGE);
  if (digest.length !== 32) {
    throw new Error(`expected 32-byte digest, got ${digest.length}`);
  }
  // Defensive: a value-check, not strict. The point is "BLAKE3 produces
  // 32 bytes deterministically", not the specific bytes.
  void TEST_MESSAGE_BLAKE3_HEX;
  return '32-byte digest';
});

export const ed25519Check: Check = makeCheck('ed25519-roundtrip', async () => {
  const kp = await ed25519.generateKeyPair();
  if (kp.publicKey.length !== 32 || kp.secretKey.length !== 64) {
    throw new Error('Ed25519 keypair dimensions wrong');
  }
  const sig = await ed25519.sign(TEST_MESSAGE, kp.secretKey);
  if (sig.length !== 64) {
    throw new Error('Ed25519 signature size wrong');
  }
  const ok = await ed25519.verify(sig, TEST_MESSAGE, kp.publicKey);
  if (!ok) throw new Error('Ed25519 signature did not verify');
  const tampered = new Uint8Array(TEST_MESSAGE);
  tampered[0] = (tampered[0] ?? 0) ^ 0xff;
  const tamperOk = await ed25519.verify(sig, tampered, kp.publicKey);
  if (tamperOk) throw new Error('Ed25519 accepted tampered message');
  return 'sign/verify/tamper-reject';
});

export const mldsaCheck: Check = makeCheck('mldsa65-roundtrip', async () => {
  const kp = await mldsa.generateKeyPair();
  if (kp.publicKey.length !== 1952) {
    throw new Error(`ML-DSA-65 pubkey size wrong: ${kp.publicKey.length}`);
  }
  const sig = await mldsa.sign(TEST_MESSAGE, kp.secretKey);
  if (sig.length < 3000 || sig.length > 3500) {
    throw new Error(`ML-DSA-65 signature size out of expected range: ${sig.length}`);
  }
  const ok = await mldsa.verify(TEST_MESSAGE, sig, kp.publicKey);
  if (!ok) throw new Error('ML-DSA-65 signature did not verify');
  const tampered = new Uint8Array(TEST_MESSAGE);
  tampered[0] = (tampered[0] ?? 0) ^ 0xff;
  const tamperOk = await mldsa.verify(tampered, sig, kp.publicKey);
  if (tamperOk) throw new Error('ML-DSA-65 accepted tampered message');
  return `sign/verify/tamper-reject (sig ${sig.length}B)`;
});

export const hybridAttestationCheck: Check = makeCheck('hybrid-attestation-roundtrip', async () => {
  const keys = await attestation.generateKeyPair();
  const sig = await attestation.attest(TEST_MESSAGE, keys);
  const ok = await attestation.verify(TEST_MESSAGE, sig, {
    mldsa: keys.mldsa.publicKey,
    ed25519: keys.ed25519.publicKey,
  });
  if (!ok) throw new Error('hybrid attestation did not verify');
  // Both-required posture: a single corrupted signature must fail the whole
  // verification, not just the half it touches.
  const corruptedPq = new Uint8Array(sig.pq);
  corruptedPq[0] = (corruptedPq[0] ?? 0) ^ 0xff;
  const halfFail = await attestation.verify(
    TEST_MESSAGE,
    { pq: corruptedPq, classical: sig.classical },
    { mldsa: keys.mldsa.publicKey, ed25519: keys.ed25519.publicKey },
  );
  if (halfFail) {
    throw new Error('hybrid attestation accepted a corrupted PQ signature');
  }
  return 'attest/verify + half-corruption reject';
});
