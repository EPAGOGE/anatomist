// Argon2id password hashing.
//
// Parameters per OWASP 2024 minimum (see ADR-0018):
//   memory:      64 MiB (65536 KiB)
//   iterations:  3
//   parallelism: 4
//   hash length: 32 bytes
//   salt length: 16 bytes (argon2 lib default; randomized per hash)
//
// Type 'id' is the OWASP recommended argon2 variant — combines argon2i's
// side-channel resistance with argon2d's GPU resistance.
//
// REMINDER (ADR-0008 boundary): password hashing and verification are
// deterministic operations. AI MUST NOT be invoked on any path through
// this module. The reliability of authentication depends on it.

import argon2 from 'argon2';

export const ARGON2ID_PARAMS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
});

/**
 * Hash a plaintext password. Returns the argon2 encoded string (which
 * embeds the parameters used) — that string is what gets stored in
 * users.password_hash. The same string is what verifyPassword reads back.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) {
    throw new Error('refusing to hash an empty password');
  }
  return argon2.hash(plaintext, ARGON2ID_PARAMS);
}

/**
 * Verify a plaintext password against an argon2 encoded hash. Returns
 * true/false. Constant-time within argon2's implementation. Throws only
 * on a malformed hash string.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // verify throws on malformed hashes; treat as not-a-match rather than
    // leaking detail to the caller.
    return false;
  }
}

/**
 * Defense against timing-based account enumeration. The caller has decided
 * an account doesn't exist (and therefore has no hash to verify against),
 * but we still want this code path to spend roughly the same time argon2
 * verify does. Hash a fixed dummy password against a sentinel hash with
 * the same parameters; throw away the result.
 */
const DUMMY_HASH_PLAINTEXT = 'epagoge-timing-equalizer-do-not-store';
let dummyHashCache: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  if (!dummyHashCache) {
    dummyHashCache = argon2.hash(DUMMY_HASH_PLAINTEXT, ARGON2ID_PARAMS);
  }
  return dummyHashCache;
}

/**
 * Burn roughly the same wall time as a real argon2 verify. Use this when
 * the caller hit a "no such account" case and wants to avoid leaking that
 * fact through response timing.
 */
export async function timingEqualizer(): Promise<void> {
  const h = await dummyHash();
  await argon2.verify(h, 'never-matches').catch(() => undefined);
}
