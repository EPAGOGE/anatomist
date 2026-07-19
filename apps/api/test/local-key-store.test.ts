import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadLocalIdentity,
  saveLocalIdentity,
  ensureLocalIdentity,
  type LocalIdentity,
} from '../src/identity/local-key-store.js';

let tempDirs: string[] = [];

async function makeTempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'epagoge-keys-'));
  tempDirs.push(dir);
  return join(dir, 'identity.json');
}

afterEach(async () => {
  for (const dir of tempDirs) {
    // Defensive: only allow paths under mkdtemp's known prefix.
    if (!dir.includes('epagoge-keys-')) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs = [];
});

const sampleIdentity = (sourceId: string): LocalIdentity => ({
  sourceId,
  mldsa: {
    publicKey: new Uint8Array([0x01, 0x02, 0x03]),
    secretKey: new Uint8Array([0xaa, 0xbb, 0xcc]),
  },
  ed25519: {
    publicKey: new Uint8Array([0x11, 0x12]),
    secretKey: new Uint8Array([0xdd, 0xee]),
  },
});

describe('local-key-store', () => {
  it('save then load round-trips the identity', async () => {
    const path = await makeTempPath();
    const id = sampleIdentity('round-trip');
    await saveLocalIdentity(id, path);

    const loaded = await loadLocalIdentity(path);
    expect(loaded).not.toBeNull();
    expect(loaded?.sourceId).toBe('round-trip');
    expect(Array.from(loaded!.mldsa.publicKey)).toEqual([0x01, 0x02, 0x03]);
    expect(Array.from(loaded!.mldsa.secretKey)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(Array.from(loaded!.ed25519.publicKey)).toEqual([0x11, 0x12]);
    expect(Array.from(loaded!.ed25519.secretKey)).toEqual([0xdd, 0xee]);
  });

  it('returns null when file does not exist', async () => {
    const path = await makeTempPath();
    expect(await loadLocalIdentity(path)).toBeNull();
  });

  it('writes file with mode 0600 on POSIX systems', async () => {
    const path = await makeTempPath();
    await saveLocalIdentity(sampleIdentity('mode-test'), path);
    const info = await stat(path);
    if (process.platform !== 'win32') {
      // Mask off owner bits and compare; group/other bits should be zero.
      const mode = info.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('writes JSON containing base64 encodings (not raw bytes)', async () => {
    const path = await makeTempPath();
    await saveLocalIdentity(sampleIdentity('format-test'), path);
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.source_id).toBe('format-test');
    expect(typeof parsed.mldsa.public_key).toBe('string');
    expect(typeof parsed.ed25519.secret_key).toBe('string');
    // Base64 of [0x01, 0x02, 0x03] = "AQID"
    expect(parsed.mldsa.public_key).toBe('AQID');
  });

  it('ensureLocalIdentity creates when absent', async () => {
    const path = await makeTempPath();
    const { identity, created } = await ensureLocalIdentity('new-source', path);
    expect(created).toBe(true);
    expect(identity.sourceId).toBe('new-source');
    expect(identity.mldsa.publicKey.length).toBeGreaterThan(0);
    expect(identity.ed25519.publicKey.length).toBe(32);
  });

  it('ensureLocalIdentity reuses when present', async () => {
    const path = await makeTempPath();
    const first = await ensureLocalIdentity('reuse-source', path);
    const second = await ensureLocalIdentity('reuse-source', path);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(Array.from(second.identity.mldsa.secretKey)).toEqual(
      Array.from(first.identity.mldsa.secretKey),
    );
  });

  it('ensureLocalIdentity refuses to overwrite when source_id mismatches', async () => {
    const path = await makeTempPath();
    await ensureLocalIdentity('source-a', path);
    await expect(ensureLocalIdentity('source-b', path)).rejects.toThrow(/source-a/);
  });

  it('rejects a malformed identity file', async () => {
    const path = await makeTempPath();
    await saveLocalIdentity(sampleIdentity('valid'), path);
    // Overwrite with junk that parses as JSON but lacks required fields.
    await (
      await import('node:fs/promises')
    ).writeFile(path, JSON.stringify({ source_id: 'broken' }));
    await expect(loadLocalIdentity(path)).rejects.toThrow(/missing required fields/);
  });
});
