import { describe, it, expect } from 'vitest';
import {
  makeMasterKey,
  encryptEnvelope,
  decryptEnvelope,
  loadMasterKey,
} from '../../src/auth/master-key.js';

const HEX_64_A = 'a'.repeat(64);
const HEX_64_B = 'b'.repeat(64);

describe('master-key', () => {
  it('encrypts and decrypts roundtrip', () => {
    const master = makeMasterKey(HEX_64_A);
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const envelope = encryptEnvelope(plaintext, master);
    const decrypted = decryptEnvelope(envelope, master);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('produces different envelopes for same plaintext (random IV)', () => {
    const master = makeMasterKey(HEX_64_A);
    const plaintext = new Uint8Array([42]);
    const a = encryptEnvelope(plaintext, master);
    const b = encryptEnvelope(plaintext, master);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('decrypting with wrong key throws (GCM auth tag mismatch)', () => {
    const a = makeMasterKey(HEX_64_A);
    const b = makeMasterKey(HEX_64_B);
    const env = encryptEnvelope(new Uint8Array([1, 2, 3]), a);
    expect(() => decryptEnvelope(env, b)).toThrow();
  });

  it('rejects malformed env var', () => {
    expect(() => loadMasterKey('not-hex')).toThrow();
  });

  it('rejects missing env var when nothing is supplied', () => {
    const saved = process.env.MASTER_ENCRYPTION_KEY;
    delete process.env.MASTER_ENCRYPTION_KEY;
    try {
      expect(() => loadMasterKey(undefined)).toThrow();
    } finally {
      if (saved !== undefined) process.env.MASTER_ENCRYPTION_KEY = saved;
    }
  });

  it('rejects an envelope shorter than IV+tag', () => {
    const master = makeMasterKey(HEX_64_A);
    expect(() => decryptEnvelope(new Uint8Array(10), master)).toThrow();
  });

  it('handles realistic-sized secret (ML-DSA-65 ~4000 bytes)', () => {
    const master = makeMasterKey(HEX_64_A);
    const plaintext = new Uint8Array(4032);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = (i * 7) & 0xff;
    const env = encryptEnvelope(plaintext, master);
    const back = decryptEnvelope(env, master);
    expect(Buffer.from(back).equals(Buffer.from(plaintext))).toBe(true);
  });
});
