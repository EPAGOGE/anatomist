# Anatomist

**A visual mechanistic-interpretability workbench with cryptographic provenance, by EPAGOGE.**

Anatomist is a local-first platform for opening up transformer language models and
keeping a verifiable record of everything you do to them. Load a model, probe its
internals from a visual toolchest, compose architectures on a canvas, and every
saved step is signed onto an append-only hash chain you can audit later.

The thesis: the people who built today's interpretability tooling built it for
people like themselves. Anatomist keeps the math one click away, but leads with
the visual, so pattern-first thinkers can work a real MI workflow without the
priesthood. The tools are real, the models are real, and honesty is enforced by
design: when a backend or capability is missing, features degrade to clearly
labeled stubs instead of pretending.

## What's inside

| Surface         | What it does                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model Library   | Searchable catalog (GPT-2, Pythia, Gemma 2, Llama 3.2). One-click load via TransformerLens; per-model tool availability shown honestly.                                            |
| Probe Toolchest | Attention patterns, logit lens, activation patching, ablation sweeps, head census, saliency, max-activating examples, model diff, and more. Every probe exports the Python it ran. |
| Canvas          | Compose model architectures visually. Every save is signed (Ed25519 + ML-DSA-65 hybrid) onto your chain with a reasoning record.                                                   |
| Chains          | Browse and search the append-only provenance ledger. Pin events, walk history to genesis, verify signatures.                                                                       |
| Chat            | Talk to a loaded model with activation capture, or bring your own frontier-model API key (calls go direct from your browser; keys never touch the server).                         |
| SAE sidecar     | Sparse-autoencoder feature browsing where published SAEs exist.                                                                                                                    |

## Quickstart

Requirements: Node 20+, Python 3.10-3.13, Docker (for Postgres + Redis).

```bash
git clone https://github.com/EPAGOGE/anatomist.git
cd anatomist
docker compose -f infra/docker-compose.yml up -d   # postgres + redis
npm install
npm run workbench
```

Then open http://localhost:5173.

That's the whole setup. The bootstrap script creates the Python venvs, installs
ML dependencies once (~2 GB, first run only), copies env files, runs migrations,
and starts everything. There is no login: the app provisions a local owner
identity on first boot, generates its own signing secrets, and keeps them in a
gitignored local directory. Single-user by design; you host it, you own it.

Optional: add an `HF_TOKEN` in `apps/mi-backend/.env` for gated models
(Gemma, Llama), and an `ANTHROPIC_API_KEY` in `.env` for the platform chat.
Everything else works without either.

## Architecture

| Service      | Port | Stack                                                                   |
| ------------ | ---- | ----------------------------------------------------------------------- |
| Web app      | 5173 | React + Vite + Tailwind                                                 |
| Platform API | 3000 | Fastify + Postgres + Redis (chains, projects, canvas, AI orchestration) |
| MI backend   | 8765 | FastAPI + TransformerLens (model loading, probes, activation capture)   |
| SAE sidecar  | 8766 | FastAPI + sae_lens (its own venv; different pins)                       |

The provenance layer is the platform's spine: an append-only event ledger in
Postgres where every event is hybrid-signed, hash-linked to its predecessors,
and walkable to genesis. Signature verification is enforced at read time, not
assumed.

## Development

```bash
npm run typecheck   # tsc across the workspaces
npm test            # vitest (api + packages), live tests need the infra up
cd apps/mi-backend && .venv/bin/python -m pytest   # backend probes
```

A built-in doctor (`apps/api/src/doctor/`) checks the environment end to end:
crypto roundtrips, chain integrity, signature verification, route-emission
discipline.

## License

MIT. See [LICENSE](LICENSE).
