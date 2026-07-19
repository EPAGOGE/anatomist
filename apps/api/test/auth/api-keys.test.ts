import { describe, it, expect } from 'vitest';
import { mintApiKey, parseApiKey, verifyApiKeyAgainstRow } from '../../src/auth/api-keys.js';
import type { ApiKeyRow } from '../../src/db/schema.js';

function rowFromMint(
  m: ReturnType<typeof mintApiKey>,
  overrides: Partial<ApiKeyRow> = {},
): ApiKeyRow {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'test',
    keyHash: m.keyHash,
    prefix: m.prefix,
    createdAt: new Date(2026, 0, 1),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  } as ApiKeyRow;
}

describe('api-keys', () => {
  it('mints a key with epak_ format', () => {
    const m = mintApiKey();
    expect(m.plaintext.startsWith('epak_')).toBe(true);
    expect(m.prefix.length).toBe(16);
    expect(m.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses a freshly-minted key back to its prefix and secret', () => {
    const m = mintApiKey();
    const parsed = parseApiKey(m.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe(m.prefix);
  });

  it('parseApiKey rejects non-epak strings', () => {
    expect(parseApiKey('not_an_api_key')).toBeNull();
    expect(parseApiKey('epak_short')).toBeNull();
    expect(parseApiKey('epak_TOOSHORTSUFFIX_short')).toBeNull();
  });

  it('verifies a freshly-minted key against its row', () => {
    const m = mintApiKey();
    const parsed = parseApiKey(m.plaintext)!;
    expect(verifyApiKeyAgainstRow(parsed.secret, rowFromMint(m))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const m = mintApiKey();
    expect(verifyApiKeyAgainstRow('ABCDEFGHIJKLMNOPQRSTUVWX', rowFromMint(m))).toBe(false);
  });

  it('rejects a revoked key', () => {
    const m = mintApiKey();
    const parsed = parseApiKey(m.plaintext)!;
    const row = rowFromMint(m, { revokedAt: new Date(2025, 0, 1) });
    expect(verifyApiKeyAgainstRow(parsed.secret, row)).toBe(false);
  });

  it('rejects an expired key', () => {
    const m = mintApiKey();
    const parsed = parseApiKey(m.plaintext)!;
    const row = rowFromMint(m, { expiresAt: new Date(2020, 0, 1) });
    expect(verifyApiKeyAgainstRow(parsed.secret, row)).toBe(false);
  });

  it('honors a future-dated expiry', () => {
    const m = mintApiKey();
    const parsed = parseApiKey(m.plaintext)!;
    const row = rowFromMint(m, { expiresAt: new Date(2099, 0, 1) });
    expect(verifyApiKeyAgainstRow(parsed.secret, row)).toBe(true);
  });
});
