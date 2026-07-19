#!/usr/bin/env node
// npm run workbench — one-command MI Workbench bootstrap + launch.
//
// Clone → `npm install` → `npm run workbench` → probing a real model.
//
// What it does, in order (each step idempotent and honest about cost):
//   1. Python venv for apps/mi-backend (created if missing; needs python3.10+,
//      prefers python3.13 — the torchvision-wheel-gap lesson).
//   2. Base + dev deps (fast). ML deps ([ml] extra: torch + transformer-lens,
//      ~2 GB download) installed only if torch is missing — one time.
//   3. .env from .env.example if absent (HF_TOKEN optional; only gated models
//      need it — gpt2 works without).
//   4. Infra check (Postgres + Redis) via the API's own infra:check. Fails
//      loudly with instructions rather than letting the API crash later.
//   5. Launch: mi-backend (uvicorn :8765) + `npm run dev` (api + web). If
//      something already listens on :8765 it is reused, not fought over.
//
// POSIX-only (macOS/Linux). Ctrl-C tears down everything this script started.

import { execSync, spawn } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MI = join(ROOT, 'apps', 'mi-backend');
const VENV = join(MI, '.venv');
const PY = join(VENV, 'bin', 'python');
const UVICORN = join(VENV, 'bin', 'uvicorn');
const MI_PORT = process.env.MI_PORT ?? '8765';

const SAE = join(ROOT, 'apps', 'sae-backend');
const SAE_VENV = join(SAE, '.venv');
const SAE_PY = join(SAE_VENV, 'bin', 'python');
const SAE_UVICORN = join(SAE_VENV, 'bin', 'uvicorn');
const SAE_PORT = process.env.SAE_PORT ?? '8766';

const log = (msg) => console.log(`\x1b[36m[workbench]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m[workbench] ${msg}\x1b[0m`);
  process.exit(1);
};

function sh(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function shQuiet(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ---- 1. venv ----------------------------------------------------------------
function ensureVenv() {
  if (existsSync(PY)) {
    log('python venv: present');
    return;
  }
  const python =
    shQuiet('command -v python3.13') ??
    shQuiet('command -v python3.12') ??
    shQuiet('command -v python3.11') ??
    shQuiet('command -v python3.10');
  if (!python) {
    fail(
      'python 3.10+ not found. Install python 3.13 (brew install python@3.13) and rerun.\n' +
        '  (3.14 currently lacks torchvision wheels for the pinned TL version — use 3.13.)',
    );
  }
  log(`creating venv with ${python} …`);
  sh(`"${python}" -m venv "${VENV}"`);
}

// ---- 2. deps ----------------------------------------------------------------
function ensureDeps() {
  log('installing base + dev deps (fast, cached)…');
  sh(`"${PY}" -m pip install -q -e '.[dev]'`, { cwd: MI });

  const hasTorch = shQuiet(`"${PY}" -c "import torch; print(torch.__version__)"`);
  if (hasTorch) {
    log(`ML deps: present (torch ${hasTorch})`);
    return;
  }
  log('ML deps missing — installing the [ml] extra (torch + transformer-lens).');
  log('This is a ~2 GB download and happens ONCE. Go get a coffee.');
  sh(`"${PY}" -m pip install -e '.[ml]'`, { cwd: MI });
}

// ---- 2b. SAE sidecar venv + deps ---------------------------------------------
// Its own venv on purpose: sae_lens pins different TransformerLens/torch
// versions than the MI backend. The two services share nothing but HTTP.
function ensureSaeSidecar() {
  if (!existsSync(join(SAE, 'pyproject.toml'))) return; // sidecar not in this checkout

  if (!existsSync(SAE_PY)) {
    const python =
      shQuiet('command -v python3.13') ??
      shQuiet('command -v python3.12') ??
      shQuiet('command -v python3.11') ??
      shQuiet('command -v python3.10');
    if (!python) {
      log('sae sidecar: python 3.10+ not found — skipping (SAE probes will show stubs).');
      return;
    }
    log(`sae sidecar: creating venv with ${python} …`);
    sh(`"${python}" -m venv "${SAE_VENV}"`);
  }
  log('sae sidecar: installing base + dev deps…');
  sh(`"${SAE_PY}" -m pip install -q -e '.[dev]'`, { cwd: SAE });

  const hasSaeLens = shQuiet(`"${SAE_PY}" -c "import sae_lens; print(sae_lens.__version__)"`);
  if (hasSaeLens) {
    log(`sae sidecar: sae_lens present (${hasSaeLens})`);
    return;
  }
  log('sae sidecar: installing sae_lens (its own TL + torch — big, ONE time)…');
  sh(`"${SAE_PY}" -m pip install -e '.[ml]'`, { cwd: SAE });
}

// ---- 3. env -----------------------------------------------------------------
function ensureEnv() {
  const env = join(MI, '.env');
  if (existsSync(env)) {
    log('.env: present');
    return;
  }
  copyFileSync(join(MI, '.env.example'), env);
  log('.env created from .env.example — add HF_TOKEN there only if you need gated models.');
}

function ensureRootEnv() {
  // The api reads the repo-root .env (DATABASE_URL/REDIS_URL point at the
  // infra/docker-compose.yml dev services). JWT/master secrets are
  // auto-generated + persisted by the api itself (apps/api/src/load-env.ts),
  // so the copied placeholders are fine as-is.
  const rootEnv = join(ROOT, '.env');
  if (existsSync(rootEnv)) {
    log('root .env: present');
    return;
  }
  copyFileSync(join(ROOT, '.env.example'), rootEnv);
  log('root .env created from .env.example (dev database/redis defaults).');
}

// ---- 4. infra ---------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';

function findPsql() {
  return (
    shQuiet('command -v psql') ??
    ['/opt/homebrew/opt/postgresql@16/bin/psql', '/usr/local/opt/postgresql@16/bin/psql'].find(
      (p) => existsSync(p),
    ) ??
    null
  );
}

/** Idempotently create the epagoge role + database on a reachable local
 *  Postgres (fresh-clone case: the server runs, but nothing project-specific
 *  exists yet), then apply migrations. No-op when everything is present. */
function ensureDatabase() {
  const psql = findPsql();
  if (!psql) return; // no local psql — let infra:check report reachability honestly

  const q = (sql) => shQuiet(`"${psql}" -h localhost -p 5432 -d postgres -tAc "${sql}"`);

  if (q('SELECT 1') === null) return; // server not reachable via superuser — infra:check will say so

  if (!q("SELECT 1 FROM pg_roles WHERE rolname='epagoge'")) {
    log("provisioning: creating role 'epagoge' (local dev credentials)…");
    q("CREATE ROLE epagoge LOGIN PASSWORD 'epagoge_dev'");
  }
  if (!q("SELECT 1 FROM pg_database WHERE datname='epagoge'")) {
    log("provisioning: creating database 'epagoge'…");
    q('CREATE DATABASE epagoge OWNER epagoge');
  }
  log('applying database migrations…');
  try {
    sh('npm run -w @epagoge/api db:migrate', {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: DB_URL },
    });
  } catch {
    log('migrations failed — continuing so infra:check can report the real state.');
  }
  // The API refuses to boot without the local platform identity's public key
  // registered (chain verification). Seeding is idempotent for our purposes:
  // failures on an already-seeded DB are non-fatal.
  log('seeding local platform identity…');
  try {
    sh('npm run -w @epagoge/api db:seed', {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: DB_URL },
    });
  } catch {
    log(
      'seed step failed or already seeded — the API will report honestly if identity is missing.',
    );
  }
}

function checkInfra() {
  log('checking Postgres + Redis…');
  ensureDatabase();
  try {
    sh('npm run -w @epagoge/api infra:check', { cwd: ROOT });
  } catch {
    fail(
      'Postgres/Redis not reachable. Start them, then rerun. Typical local setup:\n' +
        '  brew services start postgresql@16 redis   (or your docker compose)\n' +
        '  DB url default: postgres://epagoge:epagoge_dev@localhost:5432/epagoge',
    );
  }
}

// ---- 5. launch ----------------------------------------------------------------
async function portAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function launch() {
  const children = [];
  const start = (name, cmd, args, cwd) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) log(`${name} exited with code ${code}`);
    });
    children.push(child);
  };

  if (await portAlive(MI_PORT)) {
    log(`mi-backend: already running on :${MI_PORT} — reusing it.`);
  } else {
    log(`starting mi-backend on :${MI_PORT} …`);
    start('mi-backend', UVICORN, ['main:app', '--port', MI_PORT], MI);
  }

  if (existsSync(SAE_UVICORN)) {
    if (await portAlive(SAE_PORT)) {
      log(`sae sidecar: already running on :${SAE_PORT} — reusing it.`);
    } else {
      log(`starting sae sidecar on :${SAE_PORT} …`);
      start('sae-backend', SAE_UVICORN, ['main:app', '--port', SAE_PORT], SAE);
    }
  }

  log('starting api + web (npm run dev)…');
  start('dev', 'npm', ['run', 'dev'], ROOT);

  const shutdown = () => {
    log('shutting down…');
    for (const child of children) child.kill('SIGINT');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log('workbench up. Web: http://localhost:5173 · MI backend: http://127.0.0.1:' + MI_PORT);
  log(
    'First probe: load gpt2 in the Model Library, then hit “Instrument · verify” in the Probe tab.',
  );
}

ensureVenv();
ensureDeps();
ensureSaeSidecar();
ensureEnv();
ensureRootEnv();
checkInfra();
await launch();
