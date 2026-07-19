// Hybrid attestation wrapper. See docs/adrs/0003-attestation-primitives.md.
//
// A valid attestation MUST carry both a post-quantum (ML-DSA-65) and a
// classical (Ed25519) signature, and a verifier MUST verify both. Acceptance
// requires both. This is defense-in-depth: a break in either family leaves
// the other family still binding.

import * as mldsa from './mldsa.js';
import * as ed25519 from './ed25519.js';

export interface AttestationKeyPair {
  mldsa: { publicKey: Uint8Array; secretKey: Uint8Array };
  ed25519: { publicKey: Uint8Array; secretKey: Uint8Array };
}

export interface AttestationPublicKeys {
  mldsa: Uint8Array;
  ed25519: Uint8Array;
}

export interface HybridSignature {
  pq: Uint8Array;
  classical: Uint8Array;
}

export async function generateKeyPair(): Promise<AttestationKeyPair> {
  const [mldsaKp, ed25519Kp] = await Promise.all([
    mldsa.generateKeyPair(),
    ed25519.generateKeyPair(),
  ]);
  return { mldsa: mldsaKp, ed25519: ed25519Kp };
}

export async function attest(
  payload: Uint8Array,
  keys: AttestationKeyPair,
): Promise<HybridSignature> {
  const [pq, classical] = await Promise.all([
    mldsa.sign(payload, keys.mldsa.secretKey),
    ed25519.sign(payload, keys.ed25519.secretKey),
  ]);
  return { pq, classical };
}

/**
 * Verify a hybrid attestation. Returns true ONLY when both signatures pass.
 * A single failed signature must fail the whole verification — this is the
 * load-bearing invariant of the hybrid posture.
 */
export async function verify(
  payload: Uint8Array,
  signature: HybridSignature,
  publicKeys: AttestationPublicKeys,
): Promise<boolean> {
  const [pqOk, classicalOk] = await Promise.all([
    mldsa.verify(payload, signature.pq, publicKeys.mldsa),
    ed25519.verify(signature.classical, payload, publicKeys.ed25519),
  ]);
  return pqOk && classicalOk;
}
