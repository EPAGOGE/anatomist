# MI Workbench Backend

Backend service for the EPAGOGE MI Workbench. See [`docs/MI_Workbench.md`](../../docs/MI_Workbench.md) for the full vision.

Loads transformer models via [TransformerLens](https://github.com/neelnanda-io/TransformerLens) and exposes the operations the frontend's MI Toolchest needs: attention pattern lookups, activation captures, SAE feature browsing, probe training, and more.

**Status:** V1 scaffold (2026-06-21). Routes wired, model loading lazy + stubbed. Real TransformerLens execution lands when you install the optional ML deps and provide an HF token.

---

## Quick start (local, Apple Silicon)

```bash
cd apps/mi-backend

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install the backend itself
pip install -e .

# (Optional, ~3-5 GB) install ML deps — required for real model loading
pip install -e ".[ml]"

# Provide HF token for gated models (Gemma 2 needs license-accept first)
cp .env.example .env
# edit .env, set HF_TOKEN=...

# Run
uvicorn main:app --reload --port 8765
```

Visit `http://localhost:8765/health/live` — should return `{"status": "ok"}`.
Visit `http://localhost:8765/docs` for the auto-generated OpenAPI UI.

### Hardware notes

- **M1/M2/M3 Mac with 16GB+ RAM:** `gemma-2-2b-it` runs in fp16 via PyTorch MPS. ~5GB resident.
- **Older Macs / under-resourced:** use cloud runtime (see RunPod section).
- **Linux/WSL with NVIDIA GPU:** PyTorch CUDA backend auto-detected.

---

## What works in V1

- `GET /health/live`, `GET /health/ready`
- `GET /models` — catalog of supported models with tool availability
- `GET /models/{id}` — single entry
- `POST /models/{id}/load` — eagerly load (errors if `transformer-lens` not installed)
- `WebSocket /chat/ws` — echo stub (real generation in V2)
- `POST /probe/attention_pattern` — deterministic stub pattern when ML deps missing; real pattern when loaded (V2)
- `POST /probe/activations` — stub returning shape only

The scaffold is testable end-to-end without `torch` or `transformer-lens` installed. The routes and contracts are exercised; the actual model execution is the V2 swap.

## What lands once `pip install -e '.[ml]'` + HF_TOKEN are in place

The probe routes already contain the real wiring (see `mi_backend/routes/probe.py`).
They auto-detect whether real execution is possible per request — if `transformer-lens`
is importable AND the model loads AND the hook lookup succeeds, you get real data
(`stub: false`). If any step fails, you get the deterministic stub with a `note` field
explaining why. The frontend doesn't need any code change to switch modes.

The endpoints that go real on day one of ML deps:

- `POST /probe/attention_pattern` → real attention weights via
  `bridge.run_with_cache(prompt)['blocks.{layer}.attn.hook_pattern']`
- `POST /probe/activations` → per-token L2 norms at any layer/site
- `POST /probe/logit_lens` → real top-k tokens via unembed projection

What still needs V2 follow-on code:

- Real generation streaming through `bridge.generate` in `WebSocket /chat/ws`
- Activation cache persistence across chat turns (so toolchest can probe the
  most recent response without re-running the model)
- Gemma Scope SAE feature decomposition (requires `HookedSAETransformer` —
  different loader path, lands when subsystem 3 V2 starts)
- Activation patching (cross-prompt causal interventions)
- More toolchest endpoints as Subsystem 3 grows

## TransformerLens API notes (June 2026)

TransformerLens is now community-maintained under
[TransformerLensOrg](https://github.com/TransformerLensOrg/TransformerLens).
Current stable is v3.4.0.

The major 2026 shift: `TransformerBridge` (loaded via
`TransformerBridge.boot_transformers(repo_id, device=...)`) is the canonical
loader, replacing the deprecated `HookedTransformer.from_pretrained`. Bridge
supports ~9,000 HuggingFace models across 50+ architecture families. It
defaults to raw-HF numerics; the backend calls `bridge.enable_compatibility_mode()`
immediately after loading so hook names + cache shapes match the conventions
every MI tutorial assumes.

Hook names (preserved through the compatibility layer):

- `blocks.{i}.hook_resid_pre` / `hook_resid_mid` / `hook_resid_post`
- `blocks.{i}.attn.hook_pattern` (attention weights)
- `blocks.{i}.attn.hook_z` (per-head output)
- `blocks.{i}.attn.hook_q` / `hook_k` / `hook_v`
- `blocks.{i}.hook_attn_out`, `blocks.{i}.hook_mlp_in`, `blocks.{i}.hook_mlp_out`

---

## RunPod deployment

For models too large to run locally (Gemma 2 9B, 27B, Llama 70B), deploy to a RunPod GPU pod.

```bash
# Build the image
docker build -t mi-backend .

# Push to a registry RunPod can pull from (DockerHub, GHCR, ECR, etc.)
docker tag mi-backend ghcr.io/your-org/mi-backend:latest
docker push ghcr.io/your-org/mi-backend:latest
```

Then in the RunPod console:

1. Create a Pod with the image `ghcr.io/your-org/mi-backend:latest`
2. Choose a GPU (24 GB RTX 4090 handles Gemma 2 9B; 80 GB A100 for 27B)
3. Set env vars: `HF_TOKEN`, `MI_DEFAULT_MODEL`
4. Expose port 8765
5. Point the platform's frontend at the public URL RunPod assigns

Programmatic deployment via the RunPod Python SDK lands in Subsystem 1 V2 (the "Cloud" button in the model library UI calls it).

---

## Project layout

```
apps/mi-backend/
├── main.py              # Entry — runs uvicorn
├── Dockerfile           # Container build (CUDA base for RunPod)
├── pyproject.toml       # Project metadata + deps (with optional groups)
├── requirements.txt     # Plain deps list (mirror of pyproject base)
├── .env.example         # Env vars template
└── mi_backend/
    ├── app.py           # FastAPI app factory + middleware
    ├── config.py        # Settings via pydantic-settings
    ├── models/
    │   ├── registry.py  # Canonical model catalog
    │   └── loader.py    # TransformerLens lazy loader
    ├── routes/
    │   ├── health.py    # /health/live, /health/ready
    │   ├── models.py    # /models — Subsystem 1
    │   ├── chat.py      # WebSocket /chat/ws — Subsystem 4
    │   └── probe.py     # /probe/* — Subsystem 3 (MI Toolchest)
    └── stream/
        └── tensor_ws.py # Tensor → WebSocket binary frame helper
```

---

## Development

```bash
# Install dev deps
pip install -e ".[dev]"

# Lint
ruff check .

# Test (V1: tests minimal; expand with V2)
pytest
```

---

## Companion docs

- [`docs/MI_Workbench.md`](../../docs/MI_Workbench.md) — the platform's overall vision
- [`docs/Inspection_Mode_Plan.md`](../../docs/Inspection_Mode_Plan.md) — Subsystem 2 (3D inspection) plan
- [`docs/Inspection_Mode_BbycroftStudy.md`](../../docs/Inspection_Mode_BbycroftStudy.md) — concept extraction for the 3D renderer
