// API key minting + verification.
//
// Format presented to the user:
//   epak_<prefix>_<secret>
//
//   prefix  : 16 base32 chars derived from the row id (deterministic,
//             so a hot path lookup can use it as an index). Stored in
//             api_keys.prefix.
//   secret  : 32 random bytes base32-encoded (~52 chars). Only the
//             BLAKE3 hash of the secret is stored; the plaintext is
//             returned to the user exactly once at issue time.
//
// Authentication path:
//   1. Parse 'epak_<prefix>_<secret>' from Authorization or X-Api-Key.
//   2. SELECT * FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL.
//   3. Compute BLAKE3(secret) hex, constant-time compare with row.key_hash.
//   4. If matched, UPDATE last_used_at.
//
// Lookup uses prefix not secret so the secret never lives in a
// stable string the DB indexes; the secret is the part that grants
// access and only ever appears in HTTPS-protected request headers.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { blake3 } from '@epagoge/crypto';
import type { ApiKeyRow } from '../db/schema.js';

const PREFIX_BYTES = 10; // → 16 base32 chars
const SECRET_BYTES = 32; // → ~52 base32 chars

// RFC 4648 base32 alphabet without padding.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f];
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface MintedApiKey {
  /** Stored as api_keys.prefix; safe to log. */
  prefix: string;
  /** BLAKE3 hex of the secret part; stored as api_keys.key_hash. */
  keyHash: string;
  /** Full epak_..._... string shown to the user exactly once. */
  plaintext: string;
}

export function mintApiKey(): MintedApiKey {
  const prefix = base32Encode(new Uint8Array(randomBytes(PREFIX_BYTES))).slice(0, 16);
  const secretBytes = new Uint8Array(randomBytes(SECRET_BYTES));
  const secret = base32Encode(secretBytes);
  const plaintext = `epak_${prefix}_${secret}`;
  const keyHash = bytesToHex(blake3.hash(new TextEncoder().encode(secret)));
  return { prefix, keyHash, plaintext };
}

export interface ParsedApiKey {
  prefix: string;
  secret: string;
}

export function parseApiKey(presented: string): ParsedApiKey | null {
  // epak_<16chars>_<secret>
  if (!presented.startsWith('epak_')) return null;
  const rest = presented.slice('epak_'.length);
  const sep = rest.indexOf('_');
  if (sep < 0) return null;
  const prefix = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (prefix.length !== 16 || secret.length < 16) return null;
  return { prefix, secret };
}

/**
 * Constant-time compare a presented secret against a stored hash. Returns
 * true iff BLAKE3(secret) matches row.keyHash AND the row is unrevoked and
 * unexpired.
 */
export function verifyApiKeyAgainstRow(secret: string, row: ApiKeyRow, now = new Date()): boolean {
  if (row.revokedAt && row.revokedAt <= now) return false;
  if (row.expiresAt && row.expiresAt <= now) return false;
  const computed = bytesToHex(blake3.hash(new TextEncoder().encode(secret)));
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(row.keyHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
