import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@epagoge/crypto';
import { createLocalFsBlobStore } from '../src/blob/local-fs.js';

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    // Guard against the Phase 0 sub-phase B bug class — only paths under our known prefix.
    if (!root.includes('epagoge-blob-')) continue;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  tempRoots.length = 0;
});

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'epagoge-blob-'));
  tempRoots.push(root);
  return { store: createLocalFsBlobStore({ rootDir: root }), root };
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

describe('LocalFsBlobStore', () => {
  it('put returns BLAKE3 hex hash; get round-trips', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('hello blob store');
    const expected = bytesToHex(blake3.hash(bytes));

    const hash = await store.put(bytes);
    expect(hash).toBe(expected);

    const fetched = await store.get(hash);
    expect(fetched).not.toBeNull();
    expect(Array.from(fetched!)).toEqual(Array.from(bytes));

    await store.close();
  });

  it('has returns true after put, false before', async () => {
    const { store } = await makeStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = bytesToHex(blake3.hash(bytes));

    expect(await store.has(hash)).toBe(false);
    await store.put(bytes);
    expect(await store.has(hash)).toBe(true);

    await store.close();
  });

  it('put is idempotent for identical bytes', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('idempotence');
    const h1 = await store.put(bytes);
    const h2 = await store.put(bytes);
    expect(h1).toBe(h2);

    await store.close();
  });

  it('get returns null for unknown hash', async () => {
    const { store } = await makeStore();
    const result = await store.get('0'.repeat(64));
    expect(result).toBeNull();
    await store.close();
  });

  it('delete removes blob and returns true; second delete returns false', async () => {
    const { store } = await makeStore();
    const bytes = new Uint8Array([0xff]);
    const hash = await store.put(bytes);
    expect(await store.delete(hash)).toBe(true);
    expect(await store.has(hash)).toBe(false);
    expect(await store.delete(hash)).toBe(false);
    await store.close();
  });

  it('handles large payloads beyond inline threshold', async () => {
    const { store } = await makeStore();
    const big = new Uint8Array(20_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const hash = await store.put(big);
    const fetched = await store.get(hash);
    expect(fetched?.length).toBe(20_000);
    expect(fetched?.[0]).toBe(0);
    expect(fetched?.[19_999]).toBe((20_000 - 1) & 0xff);
    await store.close();
  });

  it('rejects malformed hashes on get/has/delete', async () => {
    const { store } = await makeStore();
    await expect(store.get('not-a-hash')).rejects.toThrow(/invalid blob hash/);
    await expect(store.has('SHORTHEX')).rejects.toThrow(/invalid blob hash/);
    await expect(store.delete('ZZZ')).rejects.toThrow(/invalid blob hash/);
    await store.close();
  });

  it('two different payloads produce different hashes and both retrievable', async () => {
    const { store } = await makeStore();
    const a = new TextEncoder().encode('aaa');
    const b = new TextEncoder().encode('bbb');
    const ha = await store.put(a);
    const hb = await store.put(b);
    expect(ha).not.toBe(hb);
    expect(Array.from((await store.get(ha))!)).toEqual(Array.from(a));
    expect(Array.from((await store.get(hb))!)).toEqual(Array.from(b));
    await store.close();
  });
});
