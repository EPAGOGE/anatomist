// Dev-time .env loader. Imported as the very first thing from index.ts
// so this runs before any module accesses process.env via the lazy env
// Proxy in ./env.ts.
//
// Semantics:
//   - In production, real platform-supplied env vars always win.
//   - In dev, an empty-string env var (e.g. `ANTHROPIC_API_KEY=""` set
//     by a parent shell or Claude Desktop's environment) should NOT
//     block .env from supplying the real value — dotenv's default
//     `override: false` treats empty strings as "already set" and
//     refuses to overwrite, which is the wrong call for unset-feeling
//     empties. We patch around that by hand.
//
// Path resolution: this file lives at apps/api/src/load-env.ts, so the
// repo-root .env is three directories up. We use `import.meta.url` to
// stay correct regardless of where the process was launched from.

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const parsed = config({
  path: resolve(repoRoot, '.env'),
  // Don't apply directly — we want manual control over the merge.
  processEnv: {},
  // Quiet — suppress dotenv's promotional "tips" line.
  quiet: true,
  debug: false,
}).parsed;

if (parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    // Fill missing OR empty values. A non-empty existing value (from
    // the real platform environment) is left untouched.
    const current = process.env[key];
    if (current === undefined || current === '') {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Local-first secrets. The app is single-user and self-hosted; requiring the
// operator to hand-generate JWT/master keys before first boot is pure
// friction — and a placeholder value crashes env validation. So: when either
// secret is absent or still the .env.example placeholder, generate real keys
// once and persist them in apps/api/.local-keys/local-secrets.json
// (gitignored). Persistence matters: MASTER_ENCRYPTION_KEY envelope-encrypts
// the local user's signing keys at rest, so it must survive restarts.
// Real platform-supplied values always win over the generated ones.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const needsLocal = (v: string | undefined) => !v || !HEX64.test(v);

if (needsLocal(process.env.JWT_SECRET) || needsLocal(process.env.MASTER_ENCRYPTION_KEY)) {
  const keyDir = resolve(repoRoot, 'apps', 'api', '.local-keys');
  const keyFile = resolve(keyDir, 'local-secrets.json');
  let stored: { jwt_secret?: string; master_encryption_key?: string } = {};
  if (existsSync(keyFile)) {
    try {
      stored = JSON.parse(readFileSync(keyFile, 'utf8'));
    } catch {
      stored = {};
    }
  }
  const jwt = HEX64.test(stored.jwt_secret ?? '')
    ? stored.jwt_secret!
    : randomBytes(32).toString('hex');
  const master = HEX64.test(stored.master_encryption_key ?? '')
    ? stored.master_encryption_key!
    : randomBytes(32).toString('hex');
  if (stored.jwt_secret !== jwt || stored.master_encryption_key !== master) {
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(
      keyFile,
      JSON.stringify({ jwt_secret: jwt, master_encryption_key: master }, null, 2),
    );
  }
  if (needsLocal(process.env.JWT_SECRET)) process.env.JWT_SECRET = jwt;
  if (needsLocal(process.env.MASTER_ENCRYPTION_KEY)) process.env.MASTER_ENCRYPTION_KEY = master;
}
