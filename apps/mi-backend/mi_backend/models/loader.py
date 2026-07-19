"""Model loader — wraps TransformerLens 3.x TransformerBridge.

V1: lazy single-model loader. Loads on first request, holds in memory.
Future: model swap, multi-model serving, cloud-runtime delegation.

The HF token comes from MI settings (loaded from .env). For gated models
like Gemma 2, the user must have accepted the license at huggingface.co.

This module is import-safe even when transformer-lens is not installed —
the heavy import only happens inside `get_model()`. That keeps the
scaffold runnable for contract testing without forcing a 3-5 GB ML
install.

API notes (TransformerLens 3.4.0+, June 2026):
- `TransformerBridge.boot_transformers(repo_id, device=...)` is the
  current canonical loader. It replaces the deprecated
  `HookedTransformer.from_pretrained` (which still works but is
  scheduled for removal in 4.0).
- The bridge defaults to RAW HuggingFace numerics (no LayerNorm folding,
  no weight centering). For probe code written against legacy
  HookedTransformer numerics, call `bridge.enable_compatibility_mode()`
  immediately after loading. We do this by default — it makes hook names
  + cache contents behave the way ~every MI tutorial assumes.
- Hook name conventions (preserved through the compatibility layer):
      blocks.{i}.hook_resid_pre / hook_resid_mid / hook_resid_post
      blocks.{i}.attn.hook_pattern        (attention weights)
      blocks.{i}.attn.hook_z              (per-head output)
      blocks.{i}.attn.hook_q / hook_k / hook_v
      blocks.{i}.hook_attn_out
      blocks.{i}.hook_mlp_in / hook_mlp_out
- SAELens integration (Subsystem 3 V2) uses HookedSAETransformer, not
  TransformerBridge. When Gemma Scope wiring lands, that's a separate
  loader path — keeps the SAE-specific from_pretrained_no_processing()
  requirement isolated from the general probe path.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from mi_backend.config import get_settings, resolve_device

if TYPE_CHECKING:
    # Type-only import — keeps `mypy` and the IDE happy without forcing
    # transformer-lens to be installed at scaffold time.
    from transformer_lens.model_bridge import TransformerBridge  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)

_loaded: dict[str, Any] = {}


def _check_memory_fits(model_id: str) -> None:
    """Refuse a load that would OOM the process, with an honest message.

    Uses the registry's empirical fits_locally estimate (~8 bytes/param peak
    during compat-mode conversion). Skips silently when the model isn't in
    the catalog (can't estimate) or psutil isn't available (base install) —
    the guard degrades, it never blocks unknown-but-fine loads.
    """
    from mi_backend.models import registry

    entry = registry.get_by_id(model_id) or registry.get_by_id(_canonical_repo_id(model_id))
    if entry is None:
        return
    try:
        import psutil
    except ImportError:
        return
    available_gb = psutil.virtual_memory().available / 1e9
    if not registry.fits_locally(entry, available_gb):
        needed_gb = entry.params_b * 8.0 + 2.0
        raise RuntimeError(
            f"{entry.display_name} needs ~{needed_gb:.0f} GB free to load "
            f"(compat-mode conversion peak), but only {available_gb:.1f} GB is available. "
            f"Refusing to load rather than crash the backend. Free up memory, or use a "
            f"smaller model (gpt2 needs ~3 GB) — cloud runtimes for big models are on the "
            f"compute-spine roadmap."
        )


def get_model(model_id: str) -> TransformerBridge:
    """Load (or return cached) TransformerBridge for the given model id.

    Raises ImportError if transformer-lens isn't installed.
    Raises RuntimeError on download / load failure (often missing
    HF_TOKEN for a gated model, or unaccepted license).

    Note: model_id should be a full HF repo id like 'google/gemma-2-2b-it'
    (the alias 'gemma-2-2b-it' worked in legacy HookedTransformer but is
    not guaranteed in TransformerBridge — use the full id for safety).
    """
    if model_id in _loaded:
        return _loaded[model_id]

    # RAM guard — BEFORE any heavy import or download. The gemma-2-2b lesson:
    # compat-mode conversion peaks at ~8 bytes/param; loading a model that
    # can't fit takes down the whole process. Refuse honestly instead.
    _check_memory_fits(model_id)

    # Lazy imports so the scaffold doesn't require torch+transformer-lens
    # to start up. The actual /probe and /chat routes trigger this path.
    import os

    import torch
    from transformer_lens.model_bridge import TransformerBridge

    settings = get_settings()
    device = resolve_device(settings.device)
    dtype_map = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    torch_dtype = dtype_map.get(settings.dtype, torch.float16)

    # TransformerBridge reads HF_TOKEN from env, so set it before booting.
    # We don't want to overwrite an externally-set value; only set when
    # the user has put one in their .env and the env doesn't already
    # have one.
    if settings.hf_token and not os.environ.get("HF_TOKEN"):
        os.environ["HF_TOKEN"] = settings.hf_token

    # Resolve short aliases to full HF repo ids for known models.
    full_id = _canonical_repo_id(model_id)
    logger.info(
        "loading %s on device=%s dtype=%s (canonical: %s)",
        model_id,
        device,
        settings.dtype,
        full_id,
    )

    try:
        bridge = TransformerBridge.boot_transformers(full_id, device=device, dtype=torch_dtype)
        # Match legacy HookedTransformer numerics so probe code matches
        # the conventions every MI tutorial uses (LayerNorm folded,
        # weights centered, hook names canonical).
        bridge.enable_compatibility_mode(disable_warnings=True)
    except Exception as e:
        raise RuntimeError(
            f"failed to load {full_id}: {e}. "
            "Common causes: (1) missing HF_TOKEN for a gated model, "
            "(2) unaccepted license at huggingface.co, "
            "(3) insufficient RAM/VRAM for the model size, "
            "(4) network failure during weight download."
        ) from e

    _loaded[model_id] = bridge
    return bridge


def _canonical_repo_id(model_id: str) -> str:
    """Resolve a short alias to a full HuggingFace repo id.

    The registry uses short ids for display but TransformerBridge needs
    the full org/name form for clean downloads.
    """
    aliases = {
        "gemma-2-2b-it": "google/gemma-2-2b-it",
        "gemma-2-9b-it": "google/gemma-2-9b-it",
        "gemma-2-27b-it": "google/gemma-2-27b-it",
        "gpt2": "gpt2",
        "pythia-1b": "EleutherAI/pythia-1b",
    }
    return aliases.get(model_id, model_id)


def is_loaded(model_id: str) -> bool:
    return model_id in _loaded


def loaded_models() -> list[str]:
    return list(_loaded.keys())


def unload(model_id: str) -> bool:
    """Drop a model from memory. Returns True if anything was actually unloaded."""
    if model_id not in _loaded:
        return False
    del _loaded[model_id]
    # Encourage torch to release CUDA/MPS memory.
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            # MPS has its own cache; this is the closest equivalent.
            torch.mps.empty_cache() if hasattr(torch.mps, "empty_cache") else None
    except ImportError:
        pass
    return True
