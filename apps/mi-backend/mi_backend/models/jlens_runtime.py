"""J-lens runtime — wraps the vendored jlens engine for the MI workbench.

Intake pull #2 (MI_WORKBENCH_INTAKE.md): the Jacobian-lens readout as a
workbench probe. jlens ships VENDORED in this repo (apps/mi-backend/vendor/
jlens — see its README for provenance) so the probe works on any clone; set
JLENS_PATH to develop against a local engine copy instead. It only needs
torch + transformers, both already in this venv, so there is no dependency
conflict with TransformerLens.

Model-agnostic by construction: ModelTap loads the raw HF model itself and
locates blocks/final-norm/unembedding arch-generically (GPT-2, Llama-family,
NeoX, OPT). That means this probe works for ANY model id you connect — even
ones the TL bridge can't load — at the cost of holding its own copy of the
model weights (fp32; fine for small models, mind RAM for large ones).

The per-layer Jacobian J_l is computed once per (model, corpus) over the jlens
mini corpus and cached in JLENS_CACHE (default apps/mi-backend/.cache/jlens,
gitignored) — the first probe run on a new model is slow (a minute or more);
every run after is instant.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_APP_ROOT = Path(__file__).resolve().parents[2]  # apps/mi-backend
_VENDORED = _APP_ROOT / "vendor" / "jlens"

JLENS_PATH = Path(os.environ.get("JLENS_PATH", str(_VENDORED)))
JLENS_CACHE = Path(os.environ.get("JLENS_CACHE", str(_APP_ROOT / ".cache" / "jlens")))

# Matches run_readout.py: the mini corpus is short (~15-token) sentences, so
# only the first few positions are attention-sink-skewed.
_SKIP_FIRST = 4

# One Reader per HF model id, each holding its ModelTap + averaged J.
_readers: dict[str, Any] = {}


def _import_jlens() -> Any:
    """Import the local jlens package from JLENS_PATH, or raise ImportError."""
    if not (JLENS_PATH / "jlens" / "__init__.py").exists():
        raise ImportError(f"jlens not found at {JLENS_PATH} (set JLENS_PATH)")
    if str(JLENS_PATH) not in sys.path:
        sys.path.insert(0, str(JLENS_PATH))
    import jlens

    return jlens


def _corpus() -> list[str]:
    corpus_file = JLENS_PATH / "data" / "corpus_mini.txt"
    lines = [line.strip() for line in corpus_file.read_text().splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"empty jlens corpus at {corpus_file}")
    return lines


def get_reader(hf_model_id: str) -> tuple[Any, bool, float]:
    """Reader for a model, building tap + J on first use.

    Returns (reader, j_was_cached, j_seconds). `j_was_cached` is best-effort:
    True when the J step returned near-instantly (i.e. hit the .pt cache).
    """
    if hf_model_id in _readers:
        return _readers[hf_model_id], True, 0.0

    jl = _import_jlens()
    logger.info("jlens: engine at %s, cache at %s", JLENS_PATH, JLENS_CACHE)
    logger.info("jlens: building ModelTap for %s", hf_model_id)
    tap = jl.ModelTap(hf_model_id)

    t0 = time.time()
    J = jl.compute_jlens(tap, _corpus(), cache_dir=str(JLENS_CACHE), skip_first=_SKIP_FIRST)
    j_seconds = time.time() - t0
    reader = jl.Reader(tap, J)
    _readers[hf_model_id] = reader
    logger.info("jlens: J ready for %s in %.1fs", hf_model_id, j_seconds)
    return reader, j_seconds < 5.0, j_seconds


def readout(hf_model_id: str, prompt: str, top_k: int = 6) -> dict:
    """Full J-lens workspace readout payload (JSON-safe) + provenance fields."""
    jl = _import_jlens()
    reader, cached, j_seconds = get_reader(hf_model_id)
    payload = jl.dumpable(reader.readout_grid(prompt, top_k=top_k))
    payload["j_cached"] = cached
    payload["j_seconds"] = round(j_seconds, 1)
    return payload


def pinned_ranks(hf_model_id: str, prompt: str, tokens: list[str]) -> dict:
    """Rank (1 = top) of each pinned token across every (layer, position) cell.

    The paper's core exploration affordance: pin the concepts you care about and
    watch their rank trajectory through the grid, instead of reading top-k lists.
    """
    reader, _, _ = get_reader(hf_model_id)
    payload = reader.readout_grid(prompt, top_k=1)  # populates _full
    out: dict[str, list[list[int]]] = {}
    for tok in tokens:
        for cand in (tok, " " + tok.lstrip()):
            hm = reader.pinned_rank_heatmap(payload, cand)
            if hm is not None:
                out[tok] = hm
                break
    return {
        "tokens": payload["tokens"],
        "layers": payload["layers"],
        "layer_pct": payload["layer_pct"],
        "ranks": out,
    }


def _lens_vector(reader: Any, token: str) -> tuple[Any, int, str]:
    """J-lens vector for a single token at each layer is a ROW of W_U J_l read
    through the norm; for interventions we use the residual-space direction
    v_t(l) = J_l^T W_U[t] (the direction whose lens readout is token t).
    Returns (token_id, resolved_token_string).
    """
    tap = reader.tap
    for cand in (token, " " + token.lstrip()):
        ids = tap.tok.encode(cand, add_special_tokens=False)
        if len(ids) == 1:
            return None, ids[0], cand
    ids = tap.tok.encode(token, add_special_tokens=False)
    return None, ids[0], token


def swap_generate(
    hf_model_id: str,
    prompt: str,
    source: str,
    target: str,
    alpha: float = 1.0,
    max_new_tokens: int = 12,
    layer_lo_pct: int = 35,
    layer_hi_pct: int = 90,
) -> dict:
    """The paper's lens-coordinate swap, then generate: exchange the SOURCE
    concept's lens coordinates for the TARGET's at every position, over the
    workspace layer band, and compare clean vs swapped continuations.

    h_patched = h + V (sigma(c) - c),  c = V^+ h,  V = [v_s  v_t]
    where v_x(l) = J_l^T W_U[x] normalised — the residual direction the lens
    reads as token x. sigma swaps the two coordinates (scaled by alpha).
    """
    import torch

    reader, _, _ = get_reader(hf_model_id)
    tap = reader.tap

    _, sid, s_tok = _lens_vector(reader, source)
    _, tid, t_tok = _lens_vector(reader, target)

    # Residual-space lens directions per layer: v = J_l^T (norm-side W_U row).
    W_U = tap.W_U.to(tap.device).float()  # [vocab, d]
    dirs: dict[int, Any] = {}
    lo, hi = layer_lo_pct, layer_hi_pct
    band = [
        layer for layer in tap.probe_layers if lo <= tap.layer_pct[layer] <= hi
    ]
    for layer in band:
        J = reader.J[layer].to(tap.device).float()  # [d, d]
        v_s = torch.nn.functional.normalize(J.T @ W_U[sid], dim=0)
        v_t = torch.nn.functional.normalize(J.T @ W_U[tid], dim=0)
        dirs[layer] = torch.stack([v_s, v_t], dim=1)  # [d, 2]

    def clean_generate() -> str:
        ids, _ = tap.encode(prompt)
        with torch.no_grad():
            out = tap.model.generate(
                ids, max_new_tokens=max_new_tokens, do_sample=False,
                pad_token_id=tap.tok.pad_token_id,
            )
        return tap.tok.decode(out[0, ids.shape[1]:])

    def swapped_generate() -> str:
        handles = []

        def mk_hook(V):  # V: [d, 2]
            pinv = torch.linalg.pinv(V)  # [2, d]

            def hook(_m, _inp, out):
                h = out[0] if isinstance(out, tuple) else out  # [b, pos, d]
                c = h @ pinv.T  # [b, pos, 2] lens coordinates
                swapped = torch.flip(c, dims=[-1]) * alpha
                h_new = h + (swapped - c) @ V.T
                if isinstance(out, tuple):
                    return (h_new, *out[1:])
                return h_new

            return hook

        for layer in band:
            handles.append(tap.blocks[layer].register_forward_hook(mk_hook(dirs[layer])))
        try:
            ids, _ = tap.encode(prompt)
            with torch.no_grad():
                out = tap.model.generate(
                    ids, max_new_tokens=max_new_tokens, do_sample=False,
                    pad_token_id=tap.tok.pad_token_id,
                )
            return tap.tok.decode(out[0, ids.shape[1]:])
        finally:
            for h in handles:
                h.remove()

    return {
        "source": s_tok,
        "target": t_tok,
        "band_layers": band,
        "band_pct": [tap.layer_pct[layer] for layer in band],
        "clean": clean_generate(),
        "swapped": swapped_generate(),
    }


def concept_score(
    hf_model_id: str, prompt: str, concept_tokens: list[str], control_tokens: list[str]
) -> dict:
    """The paper's concept-set score (their eval-awareness screen): mean lens
    log-prob of the concept tokens minus the controls, per position, averaged
    over the workspace layers. One scalar per position — cheap monitoring.
    """
    import torch

    reader, _, _ = get_reader(hf_model_id)
    tap = reader.tap
    payload = reader.readout_grid(prompt, top_k=1)  # populates _full [pos, vocab]

    def ids_for(tokens: list[str]) -> list[int]:
        out = []
        for tok in tokens:
            for cand in (tok, " " + tok.lstrip()):
                enc = tap.tok.encode(cand, add_special_tokens=False)
                if len(enc) == 1:
                    out.append(enc[0])
                    break
        return out

    concept_ids = ids_for(concept_tokens)
    control_ids = ids_for(control_tokens)
    if not concept_ids or not control_ids:
        raise RuntimeError("concept/control tokens did not resolve to single tokens")

    layers = payload["layers"]
    seq = len(payload["tokens"])
    scores: list[float] = []
    for p in range(seq):
        per_layer = []
        for layer in layers:
            probs = payload["_full"][layer][p]  # [vocab]
            logp = torch.log(probs + 1e-12)
            per_layer.append(
                float(logp[concept_ids].mean() - logp[control_ids].mean())
            )
        scores.append(sum(per_layer) / len(per_layer))
    return {
        "tokens": payload["tokens"],
        "scores": scores,
        "concept_resolved": len(concept_ids),
        "control_resolved": len(control_ids),
    }


def workspace_stats(hf_model_id: str, sample_prompts: list[str] | None = None) -> dict:
    """Per-layer workspace-band statistics, following the paper's Fig-'layer
    regimes' metrics (the two cheap ones): excess kurtosis of lens logits
    (near zero = no content = pre-workspace) and top-1 agreement with the
    model's actual next token (high = 'motor' regime). Cached per model.
    """
    import torch

    reader, _, _ = get_reader(hf_model_id)
    tap = reader.tap
    prompts = sample_prompts or [
        "The capital of France is the city of",
        "When Mary and John went to the store, John gave a drink to",
        "The number of legs on the animal that spins webs is",
        "Once upon a time there was a princess who lived in a",
    ]
    layers = tap.probe_layers
    kurt = {layer: [] for layer in layers}
    agree = {layer: [] for layer in layers}

    for prompt in prompts:
        ids, _ = tap.encode(prompt)
        with torch.no_grad():
            true_next = tap.model(input_ids=ids).logits[0, :-1].argmax(dim=-1)  # [pos-1]
        resid, _ = tap.forward_taps(ids, need_grad=False)
        for layer in layers:
            logits = reader._lens_logits(resid[layer], layer).float()
            x = logits - logits.mean(dim=-1, keepdim=True)
            std = x.std(dim=-1, keepdim=True) + 1e-9
            k = ((x / std) ** 4).mean(dim=-1) - 3.0  # excess kurtosis per pos
            kurt[layer].append(float(k.mean()))
            pred = logits[:-1].argmax(dim=-1)
            agree[layer].append(float((pred == true_next).float().mean()))

    return {
        "layers": layers,
        "layer_pct": [tap.layer_pct[layer] for layer in layers],
        "kurtosis": [sum(kurt[layer]) / len(kurt[layer]) for layer in layers],
        "output_agreement": [sum(agree[layer]) / len(agree[layer]) for layer in layers],
    }
