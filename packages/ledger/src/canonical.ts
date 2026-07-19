// Canonical encoding and hashing for AttestedEvent.
//
// Hashing model:
//   signed_payload = canonical_cbor(event without attestation_signature field)
//   signature_pq      = MLDSA-65 sign(signed_payload, secret_pq)
//   signature_classical = Ed25519 sign(signed_payload, secret_classical)
//   full_event_bytes = canonical_cbor(event including signatures)
//   event_hash       = BLAKE3(full_event_bytes), encoded as 64-char lowercase hex
//
// Verifying inverts: extract signing payload, re-run both signatures with
// resolver-provided public keys, accept iff both signatures verify AND
// recomputed event_hash matches stored value.

import { blake3, attestation } from '@epagoge/crypto';
import {
  type AttestedEvent,
  type AttestationSignature,
  encodeCanonicalCbor,
} from '@epagoge/shared';

export type SigningPayload = Omit<AttestedEvent, 'attestation_signature'>;

export function toSigningPayload(event: AttestedEvent): SigningPayload {
  const { attestation_signature: _ignored, ...rest } = event;
  void _ignored;
  return rest;
}

export function encodeSigningBytes(event: AttestedEvent): Uint8Array {
  return encodeCanonicalCbor(toSigningPayload(event));
}

export function encodeFullEventBytes(event: AttestedEvent): Uint8Array {
  return encodeCanonicalCbor(event);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function computeEventHash(event: AttestedEvent): string {
  const fullBytes = encodeFullEventBytes(event);
  return bytesToHex(blake3.hash(fullBytes));
}

/**
 * Public-key bundle in the ledger's idiom: pq for post-quantum, classical for
 * Ed25519. The underlying @epagoge/crypto API names them mldsa/ed25519; this
 * wrapper translates at the boundary so the ledger surface uses neutral names
 * per ADR-0009.
 */
export interface AttestationPublicKeys {
  pq: Uint8Array;
  classical: Uint8Array;
}

/**
 * Run both signature verifications over the canonical signing-payload bytes.
 * Returns true only when BOTH signatures pass. See ADR-0003.
 */
export async function verifyAttestation(
  event: AttestedEvent,
  publicKeys: AttestationPublicKeys,
): Promise<boolean> {
  const signingBytes = encodeSigningBytes(event);
  const sig: AttestationSignature = event.attestation_signature;
  return attestation.verify(
    signingBytes,
    { pq: sig.pq, classical: sig.classical },
    { mldsa: publicKeys.pq, ed25519: publicKeys.classical },
  );
}

/**
 * Produce a signed AttestedEvent from a signing payload + caller-held secrets.
 * The caller is responsible for not letting secret keys leak into AI-bearing
 * code paths (ADR-0008). This helper accepts ready-made secrets and signs.
 */
export async function signEvent(
  payload: SigningPayload,
  secrets: {
    pq: { publicKey: Uint8Array; secretKey: Uint8Array };
    classical: { publicKey: Uint8Array; secretKey: Uint8Array };
  },
): Promise<AttestedEvent> {
  const signingBytes = encodeCanonicalCbor(payload);
  const sig = await attestation.attest(signingBytes, {
    mldsa: secrets.pq,
    ed25519: secrets.classical,
  });
  return {
    ...payload,
    attestation_signature: { pq: sig.pq, classical: sig.classical },
  };
}
