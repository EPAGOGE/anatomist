"""sae_lens runtime — model + SAE registry for the sidecar.

Uses the full sae_lens ecosystem (this venv's whole reason to exist), but
sticks to its most version-stable surface: `SAE.from_pretrained` for weights
and `sae.encode` / `sae.W_dec` for math. Feature ablation subtracts a
feature's decoder direction from the residual stream directly — exact, and
robust across sae_lens API versions.

Currently wired: gpt2 with the open `gpt2-small-res-jb` release (12 layers of
resid_pre SAEs, d_sae=24576). Other models degrade with an honest note.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# model_id -> (release, sae_id template). Extend as more open SAE sets are wired.
SAE_SOURCES: dict[str, tuple[str, str]] = {
    "gpt2": ("gpt2-small-res-jb", "blocks.{layer}.hook_resid_pre"),
}

_models: dict[str, Any] = {}
_saes: dict[tuple[str, int], Any] = {}


def supported(model_id: str) -> bool:
    return model_id in SAE_SOURCES


def _get_model(model_id: str) -> Any:
    if model_id in _models:
        return _models[model_id]
    from sae_lens import HookedSAETransformer

    logger.info("sae sidecar: loading %s", model_id)
    model = HookedSAETransformer.from_pretrained(model_id)
    _models[model_id] = model
    return model


def _get_sae(model_id: str, layer: int) -> Any:
    key = (model_id, layer)
    if key in _saes:
        return _saes[key]
    from sae_lens import SAE

    release, template = SAE_SOURCES[model_id]
    sae_id = template.format(layer=layer)
    logger.info("sae sidecar: loading SAE %s / %s", release, sae_id)
    res = SAE.from_pretrained(release=release, sae_id=sae_id)
    sae = res[0] if isinstance(res, tuple) else res  # API returns tuple in some versions
    _saes[key] = sae
    return sae


def _label_tokens(model: Any, sae: Any, feature: int, k: int = 6) -> list[str]:
    """Self-contained feature label: the tokens this feature's decoder
    direction promotes, read through the model's own unembedding (the same
    labeling trick the workspace paper applies to SAE features)."""
    import torch

    with torch.no_grad():
        logits = sae.W_dec[feature].to(model.W_U.device) @ model.W_U
        top = logits.topk(k).indices
    return [model.to_string([int(t)]) for t in top]


def features(model_id: str, prompt: str, layer: int, top_k: int = 10) -> dict:
    """Top SAE features at the final token + reconstruction diagnostics.

    The FVU (fraction of variance unexplained) doubles as the reconstruction
    canary: a broken SAE/hook pairing shows up as terrible reconstruction,
    not as silently-wrong feature lists.
    """
    import torch

    model = _get_model(model_id)
    sae = _get_sae(model_id, layer)
    hook_name = sae.cfg.metadata.hook_name if hasattr(sae.cfg, "metadata") else sae.cfg.hook_name

    tokens = model.to_tokens(prompt)
    with torch.no_grad():
        _, cache = model.run_with_cache(tokens)
        x = cache[hook_name][0].to(sae.W_dec.device)  # [T, d_in]
        feats = sae.encode(x)  # [T, d_sae]
        recon = sae.decode(feats)
        fvu = float(((recon - x) ** 2).sum() / ((x - x.mean(0)) ** 2).sum())
        l0 = float((feats > 0).float().sum(-1).mean())

        pos = x.shape[0] - 1
        topv, topi = feats[pos].topk(top_k)

    out = []
    for v, fi in zip(topv, topi, strict=True):
        f = int(fi)
        out.append(
            {
                "feature": f,
                "activation": float(v),
                "label_tokens": _label_tokens(model, sae, f),
            }
        )
    return {
        "tokens": [str(t) for t in model.to_str_tokens(prompt)],
        "position": pos,
        "features": out,
        "fvu": round(fvu, 4),
        "l0": round(l0, 1),
        "d_sae": int(sae.W_dec.shape[0]),
        "hook_name": str(hook_name),
    }


def ablate_feature(model_id: str, prompt: str, layer: int, feature: int, top_k: int = 10) -> dict:
    """Knock out ONE learned feature and compare next-token predictions.

    Ablation = subtract the feature's contribution (activation x decoder
    direction) from the residual stream at every position — surgical: the
    SAE's reconstruction error and every other feature are untouched.
    """
    import torch

    model = _get_model(model_id)
    sae = _get_sae(model_id, layer)
    hook_name = sae.cfg.metadata.hook_name if hasattr(sae.cfg, "metadata") else sae.cfg.hook_name
    tokens = model.to_tokens(prompt)

    def topk_list(logits: Any) -> list[dict]:
        probs = torch.softmax(logits, dim=-1)
        top = torch.topk(logits, k=top_k)
        return [
            {"token": model.to_string([int(i)]), "logit": float(v), "prob": float(probs[i])}
            for v, i in zip(top.values, top.indices, strict=True)
        ]

    with torch.no_grad():
        clean_logits = model(tokens)[0, -1]

        w_dec_f = sae.W_dec[feature]

        def knock_out(value: Any, hook: Any) -> Any:
            x = value[0].to(sae.W_dec.device)
            acts = sae.encode(x)[:, feature]  # [T]
            value[0] = (x - acts.unsqueeze(-1) * w_dec_f).to(value.dtype).to(value.device)
            return value

        ablated_logits = model.run_with_hooks(tokens, fwd_hooks=[(hook_name, knock_out)])[0, -1]

    return {
        "feature": feature,
        "label_tokens": _label_tokens(model, sae, feature),
        "clean_top": topk_list(clean_logits),
        "ablated_top": topk_list(ablated_logits),
    }
