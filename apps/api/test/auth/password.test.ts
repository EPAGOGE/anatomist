import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  timingEqualizer,
  ARGON2ID_PARAMS,
} from '../../src/auth/password.js';

describe('password (argon2id)', () => {
  it('round-trips a known password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong horse battery staple', hash)).toBe(false);
  });

  it('rejects empty password on hash and verify', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    const hash = await hashPassword('something');
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('embeds the chosen params in the hash string', async () => {
    const hash = await hashPassword('test');
    const params = hash.match(/m=(\d+),t=(\d+),p=(\d+)/);
    expect(params).not.toBeNull();
    expect(Number(params![1])).toBe(ARGON2ID_PARAMS.memoryCost);
    expect(Number(params![2])).toBe(ARGON2ID_PARAMS.timeCost);
    expect(Number(params![3])).toBe(ARGON2ID_PARAMS.parallelism);
  });

  it('timingEqualizer completes without throwing', async () => {
    await timingEqualizer();
    await timingEqualizer(); // second call uses cached dummy hash
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });
});
