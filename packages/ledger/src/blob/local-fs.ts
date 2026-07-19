// LocalFsBlobStore — Phase 0 development backend.
//
// Layout: <rootDir>/<hash[0..2]>/<hash[2..4]>/<hash>.bin
// Two-level prefix sharding keeps any single directory under ~256 entries
// even with very large stores. Atomic writes via temp-file + rename.
//
// Phase 1 will add an S3-backed implementation behind the same interface.

import { mkdir, readFile, writeFile, rename, unlink, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { blake3 } from '@epagoge/crypto';
import type { BlobStore } from './types.js';

const HASH_RE = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function validateHash(hash: string): void {
  if (!HASH_RE.test(hash)) {
    throw new Error(`invalid blob hash (expected 64-char lowercase hex): ${hash}`);
  }
}

export interface LocalFsBlobStoreOptions {
  /** Directory under which blobs are stored. Created if missing. */
  readonly rootDir: string;
}

export function createLocalFsBlobStore(options: LocalFsBlobStoreOptions): BlobStore {
  return new LocalFsBlobStore(options.rootDir);
}

class LocalFsBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  private pathFor(hash: string): string {
    // shard1 and shard2 are first 2 and next 2 hex chars.
    return join(this.rootDir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.bin`);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = bytesToHex(blake3.hash(bytes));
    const finalPath = this.pathFor(hash);
    if (await this.fileExists(finalPath)) {
      return hash;
    }
    await mkdir(dirname(finalPath), { recursive: true });
    // Write to a temp path in the same shard, then rename for atomicity.
    const tempPath = `${finalPath}.tmp-${randomBytes(8).toString('hex')}`;
    await writeFile(tempPath, bytes);
    try {
      await rename(tempPath, finalPath);
    } catch (err) {
      // If rename fails, clean up the temp file before propagating.
      await unlink(tempPath).catch(() => undefined);
      throw err;
    }
    return hash;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    validateHash(hash);
    const path = this.pathFor(hash);
    try {
      const buf = await readFile(path);
      return new Uint8Array(buf);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'ENOENT'
      ) {
        return null;
      }
      throw err;
    }
  }

  async has(hash: string): Promise<boolean> {
    validateHash(hash);
    return this.fileExists(this.pathFor(hash));
  }

  async delete(hash: string): Promise<boolean> {
    validateHash(hash);
    const path = this.pathFor(hash);
    try {
      await unlink(path);
      return true;
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'ENOENT'
      ) {
        return false;
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    // No resources to release.
  }
}
