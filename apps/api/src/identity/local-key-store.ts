// Local hybrid-signing key persistence for Phase 0 development.
//
// PRODUCTION POSTURE: secret keys NEVER live in a file on disk. Production
// uses a key-management system (AWS KMS, Hashicorp Vault, GCP KMS) accessed
// via short-lived credentials. This module exists purely so Phase 0
// single-developer work can sign chain events without re-generating keys
// every run (which would invalidate every previously-signed event).
//
// Storage format: JSON with base64-encoded byte arrays. File mode 0600
// (owner read/write only) on POSIX systems. The directory is gitignored.

import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestation } from '@epagoge/crypto';

// Anchor the default key file to a path derived from this module's location,
// not process.cwd(). Tests and tooling invoke npm/vitest from various
// working directories; resolving relative to cwd meant a vitest run from the
// monorepo root created a stray identity at root/.local-keys/, divergent
// from the apps/api/.local-keys/ identity the DB row references. The fixed
// anchor keeps a single local identity file per workspace.
const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = apps/api/src/identity → anchor at apps/api/.local-keys/...
const DEFAULT_PATH = resolve(HERE, '..', '..', '.local-keys', 'local-identity.json');

export interface LocalIdentity {
  sourceId: string;
  mldsa: { publicKey: Uint8Array; secretKey: Uint8Array };
  ed25519: { publicKey: Uint8Array; secretKey: Uint8Array };
}

interface PersistedShape {
  source_id: string;
  mldsa: { public_key: string; secret_key: string };
  ed25519: { public_key: string; secret_key: string };
}

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function resolveKeyFilePath(explicitPath?: string): string {
  const fromEnv = process.env.EPAGOGE_LOCAL_KEY_FILE;
  if (explicitPath) return resolve(explicitPath);
  if (fromEnv) return resolve(fromEnv);
  return DEFAULT_PATH;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the local identity from disk. Returns null when no file exists yet.
 * Throws on parse / format errors so a corrupt file is surfaced immediately.
 */
export async function loadLocalIdentity(filePath?: string): Promise<LocalIdentity | null> {
  const path = resolveKeyFilePath(filePath);
  if (!(await fileExists(path))) return null;
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as PersistedShape;
  if (
    !parsed.source_id ||
    !parsed.mldsa?.public_key ||
    !parsed.mldsa?.secret_key ||
    !parsed.ed25519?.public_key ||
    !parsed.ed25519?.secret_key
  ) {
    throw new Error(`local identity file ${path} is missing required fields`);
  }
  return {
    sourceId: parsed.source_id,
    mldsa: {
      publicKey: b64decode(parsed.mldsa.public_key),
      secretKey: b64decode(parsed.mldsa.secret_key),
    },
    ed25519: {
      publicKey: b64decode(parsed.ed25519.public_key),
      secretKey: b64decode(parsed.ed25519.secret_key),
    },
  };
}

/**
 * Persist the local identity to disk. Creates the parent directory if
 * needed and sets the file mode to 0600. Overwrites any existing file
 * at the path.
 */
export async function saveLocalIdentity(
  identity: LocalIdentity,
  filePath?: string,
): Promise<string> {
  const path = resolveKeyFilePath(filePath);
  await mkdir(dirname(path), { recursive: true });
  const persisted: PersistedShape = {
    source_id: identity.sourceId,
    mldsa: {
      public_key: b64encode(identity.mldsa.publicKey),
      secret_key: b64encode(identity.mldsa.secretKey),
    },
    ed25519: {
      public_key: b64encode(identity.ed25519.publicKey),
      secret_key: b64encode(identity.ed25519.secretKey),
    },
  };
  await writeFile(path, JSON.stringify(persisted, null, 2), 'utf8');
  // chmod is best-effort — on Windows the call is a no-op for the data file.
  try {
    await chmod(path, 0o600);
  } catch {
    /* noop */
  }
  return path;
}

/**
 * Idempotent: load existing identity or generate + persist a fresh one.
 * Returns whichever applies plus a `created` flag.
 */
export async function ensureLocalIdentity(
  sourceId: string,
  filePath?: string,
): Promise<{ identity: LocalIdentity; created: boolean; path: string }> {
  const path = resolveKeyFilePath(filePath);
  const existing = await loadLocalIdentity(path);
  if (existing) {
    if (existing.sourceId !== sourceId) {
      throw new Error(
        `local identity file at ${path} is for source_id=${existing.sourceId}, requested=${sourceId}. Refusing to overwrite. Remove the file manually if a rotation is intended.`,
      );
    }
    return { identity: existing, created: false, path };
  }
  const keys = await attestation.generateKeyPair();
  const identity: LocalIdentity = {
    sourceId,
    mldsa: keys.mldsa,
    ed25519: keys.ed25519,
  };
  const written = await saveLocalIdentity(identity, path);
  return { identity, created: true, path: written };
}

export { resolveKeyFilePath as resolveKeyPath };

// Re-exported for use in tests that need a fresh location.
export { DEFAULT_PATH as DEFAULT_LOCAL_KEY_PATH };

export function _testHelperJoin(...parts: string[]): string {
  return join(...parts);
}
