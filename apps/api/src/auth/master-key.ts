// Envelope encryption for user secret attestation keys at rest.
//
// Phase 0 posture (see ADR-0020):
//   Master key is a 256-bit AES key loaded from MASTER_ENCRYPTION_KEY env
//   var (64 hex chars). Each user's two secret keys (ML-DSA-65 and Ed25519)
//   are encrypted independently with AES-256-GCM, fresh random 96-bit IV
//   per call, 128-bit auth tag included. The envelope bytes laid out as:
//     [ 12-byte IV ] [ ciphertext ] [ 16-byte GCM auth tag ]
//
// Production posture documented in ADR-0020: master key lives in a KMS
// (AWS KMS, GCP KMS, or equivalent), per-user data encryption keys are
// generated via KMS GenerateDataKey, and the envelope additionally
// contains the encrypted DEK. This module's signature stays the same;
// only the implementation of loadMasterKey changes.
//
// NEVER log master key bytes. NEVER persist them anywhere outside the env
// var / KMS. NEVER pass them across the AI boundary.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Resolve the master encryption key from env. Throws when missing or wrong
 * length. Callers that exist only when auth is mounted hold the result; it
 * does not need re-fetching per call.
 */
export function loadMasterKey(envKey?: string): Uint8Array {
  const raw = envKey ?? process.env.MASTER_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('MASTER_ENCRYPTION_KEY is not set; cannot envelope-encrypt user secret keys');
  }
  const bytes = hexToBytes(raw);
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`MASTER_ENCRYPTION_KEY must be ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export interface MasterKey {
  readonly bytes: Uint8Array;
}

export function makeMasterKey(envKey?: string): MasterKey {
  return Object.freeze({ bytes: loadMasterKey(envKey) });
}

/**
 * Encrypt a plaintext byte sequence (e.g. a secret signing key) into an
 * envelope: IV || ciphertext || authTag.
 */
export function encryptEnvelope(plaintext: Uint8Array, master: MasterKey): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, master.bytes, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, ciphertext, tag]));
}

/**
 * Decrypt an envelope produced by encryptEnvelope. Throws on a mismatched
 * auth tag (i.e. tampered ciphertext or wrong key).
 */
export function decryptEnvelope(envelope: Uint8Array, master: MasterKey): Uint8Array {
  if (envelope.length < IV_BYTES + TAG_BYTES) {
    throw new Error(`envelope too short: ${envelope.length} bytes`);
  }
  const buf = Buffer.from(envelope);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, master.bytes, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return new Uint8Array(plaintext);
}
