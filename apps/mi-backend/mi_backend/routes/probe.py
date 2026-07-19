"""Probe endpoints — Subsystem 3 (MI Toolchest backend).

Each toolchest button in the frontend hits one of these endpoints. The
endpoint runs the relevant TransformerLens code on the backend and
returns the result.

Each endpoint tries the real-execution path first (via the loader); if
transformer-lens isn't installed, the model can't load, or the hook
lookup fails, falls back to a clearly-labeled stub (`stub: true`) so
the frontend can render and the contract is exercised end-to-end.

This degrade-to-stub-with-honest-labels pattern means:
- The whole MI Workbench UI is buildable + testable without ML deps.
- The moment ML deps land (`pip install -e '.[ml]'` + HF_TOKEN), the
  stub flag flips to False and real data starts flowing — no code path
  changes on the frontend.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from transformer_lens.model_bridge import TransformerBridge  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)
router = APIRouter()


# ----- attention pattern -----------------------------------------------------


class AttentionPatternRequest(BaseModel):
    model_id: str = Field(..., description="HF / TransformerLens model id")
    prompt: str = Field(..., description="text prompt to run through the model")
    layer: int = Field(..., ge=0, description="layer index")
    head: int = Field(..., ge=0, description="attention head index")


class AttentionPatternResponse(BaseModel):
    model_id: str
    layer: int
    head: int
    tokens: list[str]
    pattern: list[list[float]]
    """[T][T] — pattern[i][j] = how much token i attends to token j."""

    stub: bool = False
    """True if this is V1 mock data. False once real model runs."""

    note: str | None = None
    """Optional explanation, used by the stub path to tell the user why."""


@router.post("/attention_pattern")
async def attention_pattern(req: AttentionPatternRequest) -> AttentionPatternResponse:
    """Return the attention pattern at one head of one layer.

    Real path: TransformerBridge.run_with_cache → cache['blocks.{layer}.attn.hook_pattern']
    Stub path: deterministic lower-triangular causal pattern so the
               frontend can render and contracts are exercised.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_attention_pattern(bridge, req)
    except ImportError as e:
        logger.info("attention_pattern degrading to stub: %s", e)
        return _stub_attention_pattern(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("attention_pattern model load failed: %s", e)
        return _stub_attention_pattern(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("attention_pattern unexpected error")
        return _stub_attention_pattern(req, note=f"unexpected error: {e}")


def _real_attention_pattern(
    bridge: TransformerBridge,
    req: AttentionPatternRequest,
) -> AttentionPatternResponse:
    """Real-execution path. Returns stub=False, actual attention weights."""
    tokens_tensor = bridge.to_tokens(req.prompt)
    _, cache = bridge.run_with_cache(tokens_tensor)
    # Full hook-name form is unambiguous across TransformerLens versions.
    hook_name = f"blocks.{req.layer}.attn.hook_pattern"
    pattern_tensor = cache[hook_name][0, req.head]  # (T, T)
    str_tokens = bridge.to_str_tokens(req.prompt)

    return AttentionPatternResponse(
        model_id=req.model_id,
        layer=req.layer,
        head=req.head,
        tokens=list(str_tokens),
        pattern=pattern_tensor.detach().cpu().tolist(),
        stub=False,
    )


def _stub_attention_pattern(
    req: AttentionPatternRequest,
    *,
    note: str,
) -> AttentionPatternResponse:
    """Fallback: deterministic causal-mask shape so the UI can render."""
    tokens = req.prompt.split()[:16] or ["<bos>"]
    n = len(tokens)
    pattern = [[1.0 / (i + 1) if j <= i else 0.0 for j in range(n)] for i in range(n)]
    return AttentionPatternResponse(
        model_id=req.model_id,
        layer=req.layer,
        head=req.head,
        tokens=tokens,
        pattern=pattern,
        stub=True,
        note=note,
    )


# ----- activations -----------------------------------------------------------


class ActivationsRequest(BaseModel):
    model_id: str
    prompt: str
    layer: int
    site: Literal["resid_pre", "resid_mid", "resid_post", "attn_out", "mlp_out"] = "resid_post"


class ActivationsResponse(BaseModel):
    model_id: str
    layer: int
    site: str
    tokens: list[str]
    shape: list[int]
    """[T, d_model] — sequence length and hidden dimension."""

    norms: list[float] | None = None
    """V2: per-token L2 norm of the activation at this site (sequence
    length T). Cheap summary that's useful in the UI before deciding
    whether to stream the full tensor."""

    stub: bool = True
    note: str | None = None


@router.post("/activations")
async def activations(req: ActivationsRequest) -> ActivationsResponse:
    """Return activations at a specific layer/site.

    Real path returns per-token norms (a compact summary). Full tensor
    streaming happens over WebSocket via mi_backend.stream.tensor_ws
    when the frontend asks for it explicitly.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_activations(bridge, req)
    except ImportError as e:
        logger.info("activations degrading to stub: %s", e)
        return _stub_activations(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("activations model load failed: %s", e)
        return _stub_activations(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("activations unexpected error")
        return _stub_activations(req, note=f"unexpected error: {e}")


_SITE_HOOK = {
    "resid_pre": "hook_resid_pre",
    "resid_mid": "hook_resid_mid",
    "resid_post": "hook_resid_post",
    "attn_out": "hook_attn_out",
    "mlp_out": "hook_mlp_out",
}


def _real_activations(
    bridge: TransformerBridge,
    req: ActivationsRequest,
) -> ActivationsResponse:
    tokens_tensor = bridge.to_tokens(req.prompt)
    _, cache = bridge.run_with_cache(tokens_tensor)
    hook_name = f"blocks.{req.layer}.{_SITE_HOOK[req.site]}"
    acts = cache[hook_name][0]  # (T, d_model)
    str_tokens = bridge.to_str_tokens(req.prompt)
    norms = acts.norm(dim=-1).detach().cpu().tolist()

    return ActivationsResponse(
        model_id=req.model_id,
        layer=req.layer,
        site=req.site,
        tokens=list(str_tokens),
        shape=list(acts.shape),
        norms=norms,
        stub=False,
    )


def _stub_activations(
    req: ActivationsRequest,
    *,
    note: str,
) -> ActivationsResponse:
    tokens = req.prompt.split()[:16] or ["<bos>"]
    # Heuristic d_model for gemma-2-2b; V2 reads this from bridge.cfg.
    return ActivationsResponse(
        model_id=req.model_id,
        layer=req.layer,
        site=req.site,
        tokens=tokens,
        shape=[len(tokens), 2304],
        stub=True,
        note=note,
    )


# ----- logit lens ------------------------------------------------------------


class LogitLensRequest(BaseModel):
    model_id: str
    prompt: str
    layer: int
    top_k: int = Field(default=10, ge=1, le=100)


class TopToken(BaseModel):
    token: str
    logit: float
    prob: float


class LogitLensResponse(BaseModel):
    model_id: str
    layer: int
    top_tokens: list[TopToken]
    stub: bool = True
    note: str | None = None


@router.post("/logit_lens")
async def logit_lens(req: LogitLensRequest) -> LogitLensResponse:
    """Project the residual stream at `layer` through the unembedding matrix.

    Real path: cache['blocks.{layer}.hook_resid_post'] → bridge.unembed →
    top-k softmax. Stub: deterministic English filler tokens.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_logit_lens(bridge, req)
    except ImportError as e:
        logger.info("logit_lens degrading to stub: %s", e)
        return _stub_logit_lens(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("logit_lens model load failed: %s", e)
        return _stub_logit_lens(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("logit_lens unexpected error")
        return _stub_logit_lens(req, note=f"unexpected error: {e}")


def _real_logit_lens(
    bridge: TransformerBridge,
    req: LogitLensRequest,
) -> LogitLensResponse:
    import torch

    tokens_tensor = bridge.to_tokens(req.prompt)
    _, cache = bridge.run_with_cache(tokens_tensor)
    resid = cache[f"blocks.{req.layer}.hook_resid_post"][0, -1].unsqueeze(0).unsqueeze(0)
    # Apply the final LayerNorm, THEN unembed — that is the model's true output
    # head. Skipping ln_final leaves the projection mis-scaled: it won't even
    # match the real next-token distribution at the last layer, and every
    # intermediate-layer probability comes out distorted. Applying it makes the
    # lens exact at the final layer and properly calibrated in between.
    ln_final = getattr(bridge, "ln_final", None)
    normed = ln_final(resid) if ln_final is not None else resid
    logits = bridge.unembed(normed)[0, 0]  # (vocab,)
    probs = torch.softmax(logits, dim=-1)
    topk = torch.topk(logits, k=req.top_k)
    top_tokens = [
        TopToken(
            token=bridge.to_string([int(idx)]),
            logit=float(val),
            prob=float(probs[idx]),
        )
        for val, idx in zip(topk.values, topk.indices, strict=True)
    ]
    return LogitLensResponse(
        model_id=req.model_id,
        layer=req.layer,
        top_tokens=top_tokens,
        stub=False,
    )


def _stub_logit_lens(req: LogitLensRequest, *, note: str) -> LogitLensResponse:
    stubs = ["the", "a", "to", "of", "and", "in", "is", "for", "on", "with"][: req.top_k]
    top = [
        TopToken(token=tok, logit=float(10 - i), prob=float(1.0 / (i + 2)))
        for i, tok in enumerate(stubs)
    ]
    return LogitLensResponse(
        model_id=req.model_id,
        layer=req.layer,
        top_tokens=top,
        stub=True,
        note=note,
    )


# ----- attention head ablation (Intervene) ----------------------------------


class AblateHeadRequest(BaseModel):
    model_id: str
    prompt: str
    layer: int = Field(..., ge=0)
    head: int = Field(..., ge=0)
    top_k: int = Field(default=10, ge=1, le=100)


class AblateHeadResponse(BaseModel):
    model_id: str
    layer: int
    head: int
    clean_top: list[TopToken]
    ablated_top: list[TopToken]
    stub: bool = False
    note: str | None = None


@router.post("/ablate_head")
async def ablate_head(req: AblateHeadRequest) -> AblateHeadResponse:
    """Zero one attention head's output and compare next-token predictions.

    The canonical causal intervention. Real path runs the prompt twice —
    clean, then with blocks.{L}.attn.hook_z for head H forced to zero — and
    returns the top-k next tokens for each. The difference between the two
    is what that head was contributing to this prediction.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_ablate_head(bridge, req)
    except ImportError as e:
        logger.info("ablate_head degrading to stub: %s", e)
        return _stub_ablate_head(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("ablate_head model load failed: %s", e)
        return _stub_ablate_head(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("ablate_head unexpected error")
        return _stub_ablate_head(req, note=f"unexpected error: {e}")


def _topk_tokens(bridge: TransformerBridge, logits: Any, k: int) -> list[TopToken]:
    """Top-k tokens from a (vocab,) logits tensor, with logit + softmax prob."""
    import torch

    probs = torch.softmax(logits, dim=-1)
    topk = torch.topk(logits, k=k)
    return [
        TopToken(token=bridge.to_string([int(idx)]), logit=float(val), prob=float(probs[idx]))
        for val, idx in zip(topk.values, topk.indices, strict=True)
    ]


def _real_ablate_head(bridge: TransformerBridge, req: AblateHeadRequest) -> AblateHeadResponse:
    tokens = bridge.to_tokens(req.prompt)
    clean_logits = bridge(tokens)[0, -1]

    hook_name = f"blocks.{req.layer}.attn.hook_z"
    head = req.head

    def zero_head(value, hook):
        # value shape: (batch, seq, n_heads, d_head). Zero this head's output.
        value[:, :, head, :] = 0.0
        return value

    ablated_logits = bridge.run_with_hooks(tokens, fwd_hooks=[(hook_name, zero_head)])[0, -1]

    return AblateHeadResponse(
        model_id=req.model_id,
        layer=req.layer,
        head=req.head,
        clean_top=_topk_tokens(bridge, clean_logits, req.top_k),
        ablated_top=_topk_tokens(bridge, ablated_logits, req.top_k),
        stub=False,
    )


def _stub_ablate_head(req: AblateHeadRequest, *, note: str) -> AblateHeadResponse:
    base = ["Paris", "the", "a", "France", "now", "home", "located", "in", "one", "called"]
    clean = [
        TopToken(token=t, logit=float(10 - i), prob=float(1.0 / (i + 2)))
        for i, t in enumerate(base[: req.top_k])
    ]
    shifted = base[1 : req.top_k + 1] + base[:1]
    ablated = [
        TopToken(token=t, logit=float(9 - i), prob=float(1.0 / (i + 2.5)))
        for i, t in enumerate(shifted[: req.top_k])
    ]
    return AblateHeadResponse(
        model_id=req.model_id,
        layer=req.layer,
        head=req.head,
        clean_top=clean,
        ablated_top=ablated,
        stub=True,
        note=note,
    )


# ----- head importance sweep (Intervene) ------------------------------------


class AblateSweepRequest(BaseModel):
    model_id: str
    prompt: str


class HeadEffect(BaseModel):
    layer: int
    head: int
    effect: float


class AblateSweepResponse(BaseModel):
    model_id: str
    n_layers: int
    n_heads: int
    clean_top_token: str
    grid: list[list[float]]
    """grid[layer][head] = effect (KL divergence between clean and ablated next-token dists)."""

    top_movers: list[HeadEffect]
    stub: bool = False
    note: str | None = None


@router.post("/ablate_sweep")
async def ablate_sweep(req: AblateSweepRequest) -> AblateSweepResponse:
    """Ablate every attention head in turn and rank them by how much each one
    changes the prediction. Turns the manual head-hunt into one click: the
    sweep computes a single effect score per (layer, head) and sorts.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_ablate_sweep(bridge, req)
    except ImportError as e:
        logger.info("ablate_sweep degrading to stub: %s", e)
        return _stub_ablate_sweep(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("ablate_sweep model load failed: %s", e)
        return _stub_ablate_sweep(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("ablate_sweep unexpected error")
        return _stub_ablate_sweep(req, note=f"unexpected error: {e}")


def _real_ablate_sweep(bridge: TransformerBridge, req: AblateSweepRequest) -> AblateSweepResponse:
    import torch

    tokens = bridge.to_tokens(req.prompt)
    clean_logits = bridge(tokens)[0, -1]
    clean_logprobs = torch.log_softmax(clean_logits, dim=-1)
    clean_probs = clean_logprobs.exp()

    n_layers = int(bridge.cfg.n_layers)
    n_heads = int(bridge.cfg.n_heads)

    grid: list[list[float]] = []
    for layer in range(n_layers):
        hook_name = f"blocks.{layer}.attn.hook_z"
        row: list[float] = []
        for head in range(n_heads):

            def zero_head(value, hook, h=head):
                value[:, :, h, :] = 0.0
                return value

            abl_logits = bridge.run_with_hooks(tokens, fwd_hooks=[(hook_name, zero_head)])[0, -1]
            abl_logprobs = torch.log_softmax(abl_logits, dim=-1)
            # KL(clean || ablated): how much the head's removal changed the
            # whole next-token distribution. Always >= 0; bigger = mattered more.
            kl = float((clean_probs * (clean_logprobs - abl_logprobs)).sum().item())
            row.append(kl)
        grid.append(row)

    flat = [(layer, head, grid[layer][head]) for layer in range(n_layers) for head in range(n_heads)]
    flat.sort(key=lambda x: x[2], reverse=True)
    top = [HeadEffect(layer=layer, head=head, effect=eff) for layer, head, eff in flat[:15]]

    return AblateSweepResponse(
        model_id=req.model_id,
        n_layers=n_layers,
        n_heads=n_heads,
        clean_top_token=bridge.to_string([int(clean_logits.argmax().item())]),
        grid=grid,
        top_movers=top,
        stub=False,
    )


def _stub_ablate_sweep(req: AblateSweepRequest, *, note: str) -> AblateSweepResponse:
    import math

    n_layers, n_heads = 12, 12
    # A fake hotspot around layer 7, head 3 so the grid renders meaningfully.
    grid = [
        [round(0.01 + 0.3 * math.exp(-(((layer - 7) ** 2 + (head - 3) ** 2) / 8)), 4) for head in range(n_heads)]
        for layer in range(n_layers)
    ]
    flat = [(layer, head, grid[layer][head]) for layer in range(n_layers) for head in range(n_heads)]
    flat.sort(key=lambda x: x[2], reverse=True)
    top = [HeadEffect(layer=layer, head=head, effect=eff) for layer, head, eff in flat[:15]]
    return AblateSweepResponse(
        model_id=req.model_id,
        n_layers=n_layers,
        n_heads=n_heads,
        clean_top_token="Paris",
        grid=grid,
        top_movers=top,
        stub=True,
        note=note,
    )


# ----- activation patching (Intervene) --------------------------------------


class PatchRequest(BaseModel):
    model_id: str
    clean_prompt: str
    corrupted_prompt: str
    answer: str
    corrupted_answer: str


class PatchResponse(BaseModel):
    model_id: str
    tokens: list[str]
    n_layers: int
    seq_len: int
    answer: str
    corrupted_answer: str
    clean_logit_diff: float
    corrupted_logit_diff: float
    grid: list[list[float]]
    """grid[layer][position] = patch score (0 = no effect, 1 = fully restores the clean answer)."""

    stub: bool = False
    note: str | None = None


@router.post("/patch")
async def patch(req: PatchRequest) -> PatchResponse:
    """Activation patching — find where the answer-distinguishing information lives.

    Run the corrupted prompt, splice in the clean residual at every
    (layer, position), and measure how far the answer flips back toward clean.
    Because both prompts share the attention sink and early-layer cascade,
    those cancel — only the real clean-vs-corrupted signal survives. The
    principled answer to 'is this just the expected artifact?'
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_patch(bridge, req)
    except ImportError as e:
        logger.info("patch degrading to stub: %s", e)
        return _stub_patch(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("patch model load failed: %s", e)
        return _stub_patch(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("patch unexpected error")
        return _stub_patch(req, note=f"unexpected error: {e}")


def _to_id(bridge: TransformerBridge, s: str) -> int:
    """Token id for an answer word, robust to the leading-space footgun.

    GPT-2 tokenizes ' poised' (one natural word token) very differently from
    'poised' (a word-start fragment). Users mean the word, so we prefer the
    space-prefixed SINGLE token when the bare string isn't already one — typing
    'poised' or ' poised' both resolve to the real word.
    """
    candidates: list[str] = []
    if not s.startswith(" "):
        candidates.append(" " + s)
    candidates.append(s)
    for cand in candidates:
        try:
            ids = bridge.to_tokens(cand, prepend_bos=False)
            if int(ids.shape[1]) == 1:
                return int(ids[0, 0])
        except Exception:
            continue
    # Fallback: first token of the original string.
    ids = bridge.to_tokens(s, prepend_bos=False)
    return int(ids[0, 0])


def _real_patch(bridge: TransformerBridge, req: PatchRequest) -> PatchResponse:

    clean_tokens = bridge.to_tokens(req.clean_prompt)
    corr_tokens = bridge.to_tokens(req.corrupted_prompt)
    seq_len = int(clean_tokens.shape[1])
    if corr_tokens.shape[1] != seq_len:
        return _stub_patch(
            req,
            note=(
                f"clean and corrupted prompts must tokenize to the same length "
                f"(clean={seq_len}, corrupted={int(corr_tokens.shape[1])}) — patching aligns "
                "them position by position. Swap a single word, keep everything else identical."
            ),
        )

    answer_id = _to_id(bridge, req.answer)
    corr_answer_id = _to_id(bridge, req.corrupted_answer)
    n_layers = int(bridge.cfg.n_layers)

    def logit_diff(logits: Any) -> float:
        last = logits[0, -1]
        return float((last[answer_id] - last[corr_answer_id]).item())

    clean_logits, clean_cache = bridge.run_with_cache(clean_tokens)
    clean_ld = logit_diff(clean_logits)
    corr_ld = logit_diff(bridge(corr_tokens))
    denom = (clean_ld - corr_ld) if abs(clean_ld - corr_ld) > 1e-6 else 1e-6

    grid: list[list[float]] = []
    for layer in range(n_layers):
        hook_name = f"blocks.{layer}.hook_resid_post"
        clean_act = clean_cache[hook_name]  # [1, seq, d_model]
        row: list[float] = []
        for pos in range(seq_len):

            def patch_pos(value, hook, p=pos, ca=clean_act):
                value[:, p, :] = ca[:, p, :]
                return value

            patched = bridge.run_with_hooks(corr_tokens, fwd_hooks=[(hook_name, patch_pos)])
            row.append(float((logit_diff(patched) - corr_ld) / denom))
        grid.append(row)

    return PatchResponse(
        model_id=req.model_id,
        tokens=list(bridge.to_str_tokens(req.clean_prompt)),
        n_layers=n_layers,
        seq_len=seq_len,
        answer=req.answer,
        corrupted_answer=req.corrupted_answer,
        clean_logit_diff=clean_ld,
        corrupted_logit_diff=corr_ld,
        grid=grid,
        stub=False,
    )


def _stub_patch(req: PatchRequest, *, note: str) -> PatchResponse:
    import math

    n_layers, seq_len = 12, 8
    tokens = (req.clean_prompt.split()[:seq_len] or ["<bos>"])[:seq_len]
    seq_len = len(tokens)
    # Fake hotspot mid-network at the last couple of positions.
    grid = [
        [round(0.9 * math.exp(-(((layer - 6) ** 2) / 6 + ((pos - (seq_len - 2)) ** 2) / 2)), 4) for pos in range(seq_len)]
        for layer in range(n_layers)
    ]
    return PatchResponse(
        model_id=req.model_id,
        tokens=tokens,
        n_layers=n_layers,
        seq_len=seq_len,
        answer=req.answer,
        corrupted_answer=req.corrupted_answer,
        clean_logit_diff=3.5,
        corrupted_logit_diff=-2.0,
        grid=grid,
        stub=True,
        note=note,
    )


# ----- direct logit attribution (Intervene) ---------------------------------


class AttributionRequest(BaseModel):
    model_id: str
    prompt: str
    answer: str  # token_a — the "new"/target token (e.g. " poised")
    corrupted_answer: str  # token_b — the contrast token (e.g. " now")


class ComponentEffect(BaseModel):
    layer: int
    head: int  # -1 means "the layer's MLP", not an attention head
    effect: float  # signed: + pushes toward answer, - pushes toward corrupted_answer


class AttributionResponse(BaseModel):
    model_id: str
    n_layers: int
    n_heads: int
    answer: str
    corrupted_answer: str
    logit_diff: float
    head_grid: list[list[float]]
    """head_grid[layer][head] = signed direct contribution to the (answer - corrupted) logit-diff."""

    mlp: list[float]
    """mlp[layer] = signed direct contribution of that layer's MLP."""

    top_contributors: list[ComponentEffect]
    stub: bool = False
    note: str | None = None


@router.post("/logit_attribution")
async def logit_attribution(req: AttributionRequest) -> AttributionResponse:
    """Direct logit attribution — which component DIRECTLY writes the answer.

    Decompose the final logit-difference between two tokens into the direct
    contribution of every attention head and every MLP. Unlike the ablation
    sweep (which measures TOTAL effect and is dominated by the early-layer
    cascade), this measures only what each component writes straight to the
    output — so cascade-y early heads that act indirectly show ~0, and the
    components that actually carry the answer pop out. Each contribution is
    signed: + toward `answer`, - toward `corrupted_answer`.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_attribution(bridge, req)
    except ImportError as e:
        logger.info("attribution degrading to stub: %s", e)
        return _stub_attribution(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("attribution model load failed: %s", e)
        return _stub_attribution(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("attribution unexpected error")
        return _stub_attribution(req, note=f"unexpected error: {e}")


def _real_attribution(bridge: TransformerBridge, req: AttributionRequest) -> AttributionResponse:
    tokens = bridge.to_tokens(req.prompt)
    a_id = _to_id(bridge, req.answer)
    b_id = _to_id(bridge, req.corrupted_answer)
    n_layers = int(bridge.cfg.n_layers)
    n_heads = int(bridge.cfg.n_heads)
    eps = float(getattr(bridge.cfg, "eps", 1e-5))

    # The logit-difference direction in residual space. Compat mode folds the
    # final LayerNorm into W_U, so projecting the (mean-centered) residual onto
    # this direction recovers the logit-diff — making attribution linear.
    w_u = bridge.W_U  # [d_model, d_vocab]
    w_o = bridge.W_O  # [n_layers, n_heads, d_head, d_model]
    direction = w_u[:, a_id] - w_u[:, b_id]  # [d_model]

    logits, cache = bridge.run_with_cache(tokens)
    logit_diff = float((logits[0, -1, a_id] - logits[0, -1, b_id]).item())

    # Final-position LayerNorm scale (the same positive scalar for every
    # component, so it sets units without changing ranking or sign).
    resid_final = cache[f"blocks.{n_layers - 1}.hook_resid_post"][0, -1]  # [d_model]
    scale = float(((resid_final - resid_final.mean()).pow(2).mean() + eps).sqrt().item())

    def contrib(vec: Any) -> float:
        # LayerNorm centres the residual, so centre the component too; the
        # projection onto `direction` is the component's signed logit-diff push.
        centered = vec - vec.mean()
        return float((centered @ direction).item()) / scale

    head_grid: list[list[float]] = []
    mlp: list[float] = []
    for layer in range(n_layers):
        z = cache[f"blocks.{layer}.attn.hook_z"][0, -1]  # [n_heads, d_head]
        head_grid.append([contrib(z[h] @ w_o[layer, h]) for h in range(n_heads)])
        mlp.append(contrib(cache[f"blocks.{layer}.hook_mlp_out"][0, -1]))

    comps = [
        ComponentEffect(layer=layer, head=head, effect=head_grid[layer][head])
        for layer in range(n_layers)
        for head in range(n_heads)
    ]
    comps += [ComponentEffect(layer=layer, head=-1, effect=mlp[layer]) for layer in range(n_layers)]
    comps.sort(key=lambda c: abs(c.effect), reverse=True)

    return AttributionResponse(
        model_id=req.model_id,
        n_layers=n_layers,
        n_heads=n_heads,
        answer=req.answer,
        corrupted_answer=req.corrupted_answer,
        logit_diff=logit_diff,
        head_grid=head_grid,
        mlp=mlp,
        top_contributors=comps[:15],
        stub=False,
    )


def _stub_attribution(req: AttributionRequest, *, note: str) -> AttributionResponse:
    import math

    n_layers, n_heads = 12, 12
    # Fake signed hotspot: a late-layer head writes +, an early head writes -.
    head_grid = [
        [
            round(0.6 * math.exp(-(((layer - 9) ** 2 + (head - 6) ** 2) / 6)), 4)
            - round(0.3 * math.exp(-(((layer - 1) ** 2 + (head - 2) ** 2) / 4)), 4)
            for head in range(n_heads)
        ]
        for layer in range(n_layers)
    ]
    mlp = [round(0.4 * math.exp(-(((layer - 9) ** 2) / 4)), 4) for layer in range(n_layers)]
    comps = [
        ComponentEffect(layer=layer, head=head, effect=head_grid[layer][head])
        for layer in range(n_layers)
        for head in range(n_heads)
    ]
    comps += [ComponentEffect(layer=layer, head=-1, effect=mlp[layer]) for layer in range(n_layers)]
    comps.sort(key=lambda c: abs(c.effect), reverse=True)
    return AttributionResponse(
        model_id=req.model_id,
        n_layers=n_layers,
        n_heads=n_heads,
        answer=req.answer,
        corrupted_answer=req.corrupted_answer,
        logit_diff=1.0,
        head_grid=head_grid,
        mlp=mlp,
        top_contributors=comps[:15],
        stub=True,
        note=note,
    )


# ----- next-token prediction (fill the contrast pair from the model) ---------


class NextTokensRequest(BaseModel):
    model_id: str
    prompt: str
    top_k: int = Field(default=5, ge=1, le=20)


class NextTokensResponse(BaseModel):
    model_id: str
    prompt: str
    top_tokens: list[TopToken]
    stub: bool = False
    note: str | None = None


@router.post("/next_tokens")
async def next_tokens(req: NextTokensRequest) -> NextTokensResponse:
    """The model's actual top-k next tokens for a prompt.

    Powers the 'fill from the model's top guesses' button so the contrast pair
    for patching / attribution defaults to a prompt-relevant pair (top-1 vs
    top-2) instead of a stale leftover — a run is meaningful even if the user
    never touches the Answer / vs. fields.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        logits = bridge(bridge.to_tokens(req.prompt))[0, -1]
        return NextTokensResponse(
            model_id=req.model_id,
            prompt=req.prompt,
            top_tokens=_topk_tokens(bridge, logits, req.top_k),
            stub=False,
        )
    except ImportError as e:
        logger.info("next_tokens degrading to stub: %s", e)
        return _stub_next_tokens(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("next_tokens model load failed: %s", e)
        return _stub_next_tokens(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("next_tokens unexpected error")
        return _stub_next_tokens(req, note=f"unexpected error: {e}")


def _stub_next_tokens(req: NextTokensRequest, *, note: str) -> NextTokensResponse:
    fillers = [" the", " a", " to", " of", " in", " now", " and", " that"]
    top = [
        TopToken(token=t, logit=float(10 - i), prob=round(0.5 * (0.6**i), 4))
        for i, t in enumerate(fillers[: req.top_k])
    ]
    return NextTokensResponse(
        model_id=req.model_id, prompt=req.prompt, top_tokens=top, stub=True, note=note
    )


# ----- instrument canary (self-test) -----------------------------------------


class CanaryRequest(BaseModel):
    model_id: str


class CanaryCheck(BaseModel):
    name: str
    passed: bool
    detail: str


class CanaryResponse(BaseModel):
    model_id: str
    verdict: str  # 'verified' | 'suspect' | 'unknown'
    checks: list[CanaryCheck]
    stub: bool = False
    note: str | None = None


@router.post("/canary")
async def canary(req: CanaryRequest) -> CanaryResponse:
    """Instrument self-test — prove the probes aren't silently lying.

    Runs ground-truth checks whose answers we know INDEPENDENTLY of the model's
    weights, so a failure means the harness is broken, not the model. This is the
    safeguard that would have caught the missing-final-LayerNorm logit-lens bug
    the moment it shipped: the lens at the final layer MUST equal the true output.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_canary(bridge, req)
    except ImportError as e:
        logger.info("canary degrading to stub: %s", e)
        return _stub_canary(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("canary model load failed: %s", e)
        return _stub_canary(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("canary unexpected error")
        return _stub_canary(req, note=f"unexpected error: {e}")


def _real_canary(bridge: TransformerBridge, req: CanaryRequest) -> CanaryResponse:
    import torch

    checks: list[CanaryCheck] = []
    prompt = "The capital of France is"
    tokens = bridge.to_tokens(prompt)
    n_layers = int(bridge.cfg.n_layers)

    # 1. The logit lens at the FINAL layer must equal the model's true output.
    #    This is the exact invariant the missing-ln_final bug violated.
    true_top = int(bridge(tokens)[0, -1].argmax().item())
    true_str = bridge.to_string([true_top])
    lens = _real_logit_lens(
        bridge, LogitLensRequest(model_id=req.model_id, prompt=prompt, layer=n_layers - 1, top_k=1)
    )
    lens_str = lens.top_tokens[0].token if lens.top_tokens else ""
    ok = lens_str == true_str
    checks.append(
        CanaryCheck(
            name="logit_lens_matches_output",
            passed=ok,
            detail=(
                f"final-layer lens = true output = {true_str!r}"
                if ok
                else f"MISMATCH: lens {lens_str!r} != output {true_str!r} — final LayerNorm missing?"
            ),
        )
    )

    # 2 & 3. Attention is causal (no weight on future tokens) and each row is a
    #        probability distribution (softmax rows sum to 1).
    _, cache = bridge.run_with_cache(tokens)
    pattern = cache["blocks.0.attn.hook_pattern"][0, 0]  # (query, key)
    seq = int(pattern.shape[0])
    future = float(torch.triu(pattern, diagonal=1).abs().max().item()) if seq > 1 else 0.0
    ok = future < 1e-4
    checks.append(
        CanaryCheck(
            name="attention_is_causal",
            passed=ok,
            detail=(
                f"max future-token weight {future:.2e} < 1e-4"
                if ok
                else f"NON-CAUSAL: future-token weight {future:.2e}"
            ),
        )
    )
    row_err = float((pattern.sum(dim=-1) - 1.0).abs().max().item())
    ok = row_err < 1e-3
    checks.append(
        CanaryCheck(
            name="attention_rows_sum_to_1",
            passed=ok,
            detail=(
                f"max |row-sum - 1| = {row_err:.2e} < 1e-3"
                if ok
                else f"rows are not distributions: err {row_err:.2e}"
            ),
        )
    )

    verdict = "verified" if all(c.passed for c in checks) else "suspect"
    return CanaryResponse(model_id=req.model_id, verdict=verdict, checks=checks, stub=False)


def _stub_canary(req: CanaryRequest, *, note: str) -> CanaryResponse:
    return CanaryResponse(
        model_id=req.model_id,
        verdict="unknown",
        checks=[
            CanaryCheck(name="instrument", passed=False, detail="no model loaded — cannot self-test")
        ],
        stub=True,
        note=note,
    )


# ----- neuron activations (Features) -----------------------------------------


class NeuronFiringsRequest(BaseModel):
    model_id: str
    prompt: str
    layer: int = Field(..., ge=0)
    top_k: int = Field(default=15, ge=1, le=50)


class NeuronFiring(BaseModel):
    position: int
    token: str
    neuron: int
    activation: float


class NeuronFiringsResponse(BaseModel):
    model_id: str
    layer: int
    d_mlp: int
    firings: list[NeuronFiring]
    stub: bool = False
    note: str | None = None


@router.post("/neurons")
async def neurons(req: NeuronFiringsRequest) -> NeuronFiringsResponse:
    """Top MLP-neuron firings — the classical unit of feature interpretability.

    Reads each neuron's post-activation value at every token and ranks the
    strongest neuron-on-token firings. Neurons are the PRE-SAE feature unit; they
    suffer from superposition (one neuron answers to several unrelated features),
    which is exactly what a sparse-autoencoder feature probe is built to fix — the
    natural next probe in this category.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_neurons(bridge, req)
    except ImportError as e:
        logger.info("neurons degrading to stub: %s", e)
        return _stub_neurons(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("neurons model load failed: %s", e)
        return _stub_neurons(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("neurons unexpected error")
        return _stub_neurons(req, note=f"unexpected error: {e}")


def _real_neurons(bridge: TransformerBridge, req: NeuronFiringsRequest) -> NeuronFiringsResponse:
    import torch

    tokens = bridge.to_tokens(req.prompt)
    _, cache = bridge.run_with_cache(tokens)
    acts = cache[f"blocks.{req.layer}.mlp.hook_post"][0]  # [seq, d_mlp], post-activation
    d_mlp = int(acts.shape[1])
    str_tokens = list(bridge.to_str_tokens(req.prompt))

    flat = acts.reshape(-1)
    k = min(req.top_k, int(flat.numel()))
    topv, topi = torch.topk(flat, k)
    firings: list[NeuronFiring] = []
    for val, idx in zip(topv, topi, strict=True):
        pos = int(idx.item()) // d_mlp
        neuron = int(idx.item()) % d_mlp
        token = str_tokens[pos] if pos < len(str_tokens) else "?"
        firings.append(
            NeuronFiring(position=pos, token=token, neuron=neuron, activation=float(val.item()))
        )
    return NeuronFiringsResponse(
        model_id=req.model_id, layer=req.layer, d_mlp=d_mlp, firings=firings, stub=False
    )


# ----- J-lens workspace readout (Inspect) -------------------------------------
#
# Intake pull #2: the ~/jlens Jacobian-lens engine as a workbench probe.
# lens(h_l) = softmax(W_U · norm(J_l h_l)) where J_l is the averaged Jacobian
# of the final residual w.r.t. layer l's residual — recovering interpretable
# workspace content DEEPER than the logit lens (which is the J = I special case).


class JlensRequest(BaseModel):
    model_id: str
    prompt: str
    top_k: int = Field(default=6, ge=1, le=12)


class JlensResponse(BaseModel):
    model_id: str
    prompt: str
    tokens: list[str]
    layers: list[int]
    layer_pct: list[int]
    grid: dict[str, list[list[tuple[str, float]]]]
    """grid[layer][pos] = top-k [token, prob] — what's poised in the workspace there."""

    argmax: dict[str, list[str]]
    j_cached: bool = False
    j_seconds: float = 0.0
    stub: bool = False
    note: str | None = None


@router.post("/jlens")
async def jlens_readout(req: JlensRequest) -> JlensResponse:
    """J-lens workspace readout — what token content is poised, per (layer, position).

    Runs the local jlens engine against the RAW HF model (loaded by ModelTap
    itself, arch-generically) — so this works for any connected model id,
    independent of the TL bridge. First run per model computes the averaged
    Jacobian over the jlens mini corpus (slow, then cached on disk).
    """
    try:
        from mi_backend.models import jlens_runtime, loader

        hf_id = loader._canonical_repo_id(req.model_id)
        payload = jlens_runtime.readout(hf_id, req.prompt, top_k=req.top_k)
        return JlensResponse(
            model_id=req.model_id,
            prompt=payload["prompt"],
            tokens=payload["tokens"],
            layers=payload["layers"],
            layer_pct=payload["layer_pct"],
            grid=payload["grid"],
            argmax=payload["argmax"],
            j_cached=payload["j_cached"],
            j_seconds=payload["j_seconds"],
            stub=False,
        )
    except ImportError as e:
        logger.info("jlens degrading to stub: %s", e)
        return _stub_jlens(req, note=f"jlens engine unavailable: {e}")
    except RuntimeError as e:
        logger.warning("jlens failed: %s", e)
        return _stub_jlens(req, note=f"jlens failed: {e}")
    except Exception as e:
        logger.exception("jlens unexpected error")
        return _stub_jlens(req, note=f"unexpected error: {e}")


def _stub_jlens(req: JlensRequest, *, note: str) -> JlensResponse:
    toks = req.prompt.split()[:8] or ["<bos>"]
    layers = list(range(0, 12, 2))
    fillers = ["the", "a", "of", "is", "planet", "red"]
    grid: dict[str, list[list[tuple[str, float]]]] = {}
    argmax: dict[str, list[str]] = {}
    for li, layer in enumerate(layers):
        row = []
        for p in range(len(toks)):
            tok = fillers[(li + p) % len(fillers)]
            row.append([(tok, round(0.6 - 0.04 * ((li + p) % 6), 3))])
        grid[str(layer)] = row
        argmax[str(layer)] = [cell[0][0] for cell in row]
    return JlensResponse(
        model_id=req.model_id,
        prompt=req.prompt,
        tokens=toks,
        layers=layers,
        layer_pct=[round(100 * layer / 11) for layer in layers],
        grid=grid,
        argmax=argmax,
        stub=True,
        note=note,
    )


# ----- surprisal: read text through the model's eyes (Inspect) ----------------


class SurprisalRequest(BaseModel):
    model_id: str
    prompt: str
    alt_k: int = Field(default=5, ge=1, le=15, description="alternatives to record per token")


class TokenSurprisal(BaseModel):
    token: str
    surprisal: float
    """-log2 p(token | context) — bits of surprise. 0 = certain, 10+ = shocked."""

    prob: float
    entropy: float
    """Entropy of the model's full distribution at this position (its uncertainty)."""

    expected: list[TopToken]
    """What the model expected instead (top alternatives)."""


class SurprisalResponse(BaseModel):
    model_id: str
    tokens: list[TokenSurprisal]
    mean_surprisal: float
    stub: bool = False
    note: str | None = None


@router.post("/surprisal")
async def surprisal(req: SurprisalRequest) -> SurprisalResponse:
    """Per-token surprisal — the loss, made visible.

    For every token: how surprised was the model to see it (-log2 p, bits),
    how uncertain was it overall (entropy), and what did it expect instead.
    Reading text through the model's eyes: confident spans are easy or
    memorized; spikes are where its expectations broke. One forward pass —
    the highest insight-per-FLOP view there is.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_surprisal(bridge, req)
    except ImportError as e:
        logger.info("surprisal degrading to stub: %s", e)
        return _stub_surprisal(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("surprisal model load failed: %s", e)
        return _stub_surprisal(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("surprisal unexpected error")
        return _stub_surprisal(req, note=f"unexpected error: {e}")


def _real_surprisal(bridge: TransformerBridge, req: SurprisalRequest) -> SurprisalResponse:
    import math

    import torch

    tokens = bridge.to_tokens(req.prompt)
    logits = bridge(tokens)[0].float()  # [T, vocab]
    logprobs = torch.log_softmax(logits, dim=-1)
    probs = logprobs.exp()
    str_tokens = list(bridge.to_str_tokens(req.prompt))

    # First token has no context to be predicted from — rendered neutral.
    out: list[TokenSurprisal] = [
        TokenSurprisal(token=str_tokens[0], surprisal=0.0, prob=1.0, entropy=0.0, expected=[])
    ]
    vals: list[float] = []
    for t in range(1, len(str_tokens)):
        actual_id = int(tokens[0, t])
        bits = float(-logprobs[t - 1, actual_id] / math.log(2))
        plogp = probs[t - 1] * (logprobs[t - 1] / math.log(2))
        entropy = float(-plogp.sum())
        top = torch.topk(logits[t - 1], k=req.alt_k)
        expected = [
            TopToken(token=bridge.to_string([int(i)]), logit=float(v), prob=float(probs[t - 1, i]))
            for v, i in zip(top.values, top.indices, strict=True)
        ]
        out.append(
            TokenSurprisal(
                token=str_tokens[t],
                surprisal=round(bits, 3),
                prob=round(float(probs[t - 1, actual_id]), 5),
                entropy=round(entropy, 2),
                expected=expected,
            )
        )
        vals.append(bits)
    return SurprisalResponse(
        model_id=req.model_id,
        tokens=out,
        mean_surprisal=round(sum(vals) / max(len(vals), 1), 3),
        stub=False,
    )


def _stub_surprisal(req: SurprisalRequest, *, note: str) -> SurprisalResponse:
    words = req.prompt.split()[:16] or ["<bos>"]
    toks = [TokenSurprisal(token=words[0], surprisal=0.0, prob=1.0, entropy=0.0, expected=[])] + [
        TokenSurprisal(
            token=w,
            surprisal=round(2.0 + 7.0 * ((i * 37) % 10) / 10, 2),
            prob=0.1,
            entropy=5.0,
            expected=[TopToken(token=" the", logit=5.0, prob=0.3)],
        )
        for i, w in enumerate(words[1:])
    ]
    return SurprisalResponse(
        model_id=req.model_id, tokens=toks, mean_surprisal=5.0, stub=True, note=note
    )


# ----- unit activation: color the text by one neuron (the char-rnn classic) ---


class UnitActivationRequest(BaseModel):
    model_id: str
    prompt: str
    layer: int = Field(..., ge=0)
    unit: int = Field(..., ge=0, description="MLP neuron index at this layer")


class UnitActivationResponse(BaseModel):
    model_id: str
    layer: int
    unit: int
    tokens: list[str]
    activations: list[float]
    """Post-activation value of the chosen neuron at every token."""

    stub: bool = False
    note: str | None = None


@router.post("/unit_activation")
async def unit_activation(req: UnitActivationRequest) -> UnitActivationResponse:
    """One neuron's activation across the whole text — read along with it.

    The classic char-rnn move: color the running text by a single unit and
    discover what it tracks. Feed it a unit found via the neuron or SAE
    probes and test your story of what it does.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_unit_activation(bridge, req)
    except ImportError as e:
        logger.info("unit_activation degrading to stub: %s", e)
        return _stub_unit_activation(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("unit_activation model load failed: %s", e)
        return _stub_unit_activation(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("unit_activation unexpected error")
        return _stub_unit_activation(req, note=f"unexpected error: {e}")


def _real_unit_activation(
    bridge: TransformerBridge, req: UnitActivationRequest
) -> UnitActivationResponse:
    tokens = bridge.to_tokens(req.prompt)
    _, cache = bridge.run_with_cache(tokens)
    acts = cache[f"blocks.{req.layer}.mlp.hook_post"][0]  # [T, d_mlp]
    if req.unit >= acts.shape[1]:
        raise RuntimeError(f"unit {req.unit} out of range (d_mlp={acts.shape[1]})")
    return UnitActivationResponse(
        model_id=req.model_id,
        layer=req.layer,
        unit=req.unit,
        tokens=list(bridge.to_str_tokens(req.prompt)),
        activations=[round(float(v), 4) for v in acts[:, req.unit]],
        stub=False,
    )


def _stub_unit_activation(req: UnitActivationRequest, *, note: str) -> UnitActivationResponse:
    import math

    words = req.prompt.split()[:16] or ["<bos>"]
    return UnitActivationResponse(
        model_id=req.model_id,
        layer=req.layer,
        unit=req.unit,
        tokens=words,
        activations=[round(3.0 * math.sin(i / 2) ** 2, 3) for i in range(len(words))],
        stub=True,
        note=note,
    )


# ----- generation trace: watch it think while it writes ------------------------


class GenerateTraceRequest(BaseModel):
    model_id: str
    prompt: str
    max_new_tokens: int = Field(default=16, ge=1, le=64)
    temperature: float = Field(default=0.8, ge=0.0, le=2.0)
    top_k: int = Field(default=8, ge=1, le=20)


class GenerationStep(BaseModel):
    token: str
    prob: float
    """Probability the sampled token had at sampling time."""

    entropy: float
    """Entropy (bits) of the next-token distribution — the model's uncertainty."""

    candidates: list[TopToken]


class GenerateTraceResponse(BaseModel):
    model_id: str
    prompt: str
    completion: str
    temperature: float
    steps: list[GenerationStep]
    stub: bool = False
    note: str | None = None


@router.post("/generate_trace")
async def generate_trace(req: GenerateTraceRequest) -> GenerateTraceResponse:
    """Token-by-token generation with the distribution visible at every step.

    temperature=0 is greedy. Each step records the sampled token's own
    probability, the distribution's entropy, and the candidates that lost —
    the model 'choosing', made visible.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_generate_trace(bridge, req)
    except ImportError as e:
        logger.info("generate_trace degrading to stub: %s", e)
        return _stub_generate_trace(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("generate_trace model load failed: %s", e)
        return _stub_generate_trace(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("generate_trace unexpected error")
        return _stub_generate_trace(req, note=f"unexpected error: {e}")


def _real_generate_trace(
    bridge: TransformerBridge, req: GenerateTraceRequest
) -> GenerateTraceResponse:
    import torch

    tokens = bridge.to_tokens(req.prompt)
    steps: list[GenerationStep] = []
    pieces: list[str] = []

    for _ in range(req.max_new_tokens):
        logits = bridge(tokens)[0, -1].float()
        probs = torch.softmax(logits, dim=-1)
        entropy = float(-(probs * torch.log2(probs + 1e-12)).sum())

        if req.temperature <= 0.0:
            next_id = int(logits.argmax())
        else:
            next_id = int(torch.multinomial(torch.softmax(logits / req.temperature, -1), 1))

        top = torch.topk(logits, k=req.top_k)
        candidates = [
            TopToken(token=bridge.to_string([int(i)]), logit=float(v), prob=float(probs[i]))
            for v, i in zip(top.values, top.indices, strict=True)
        ]
        piece = bridge.to_string([next_id])
        pieces.append(piece)
        steps.append(
            GenerationStep(
                token=piece,
                prob=round(float(probs[next_id]), 4),
                entropy=round(entropy, 2),
                candidates=candidates,
            )
        )
        tokens = torch.cat(
            [tokens, torch.tensor([[next_id]], device=tokens.device, dtype=tokens.dtype)], dim=1
        )

    return GenerateTraceResponse(
        model_id=req.model_id,
        prompt=req.prompt,
        completion="".join(pieces),
        temperature=req.temperature,
        steps=steps,
        stub=False,
    )


def _stub_generate_trace(req: GenerateTraceRequest, *, note: str) -> GenerateTraceResponse:
    words = ["the", "model", "is", "not", "loaded", "yet"]
    steps = [
        GenerationStep(
            token=f" {w}",
            prob=round(0.6 - 0.05 * i, 2),
            entropy=round(2.0 + 0.3 * i, 2),
            candidates=[
                TopToken(token=f" {w}", logit=5.0, prob=0.6 - 0.05 * i),
                TopToken(token=" a", logit=3.0, prob=0.1),
            ],
        )
        for i, w in enumerate(words[: req.max_new_tokens])
    ]
    return GenerateTraceResponse(
        model_id=req.model_id,
        prompt=req.prompt,
        completion=" " + " ".join(words[: len(steps)]),
        temperature=req.temperature,
        steps=steps,
        stub=True,
        note=note,
    )


# ----- tokenizer inspector: the layer everyone skips ---------------------------


class TokenizeRequest(BaseModel):
    model_id: str
    prompt: str


class TokenInfo(BaseModel):
    token: str
    id: int
    n_bytes: int


class TokenizeResponse(BaseModel):
    model_id: str
    tokens: list[TokenInfo]
    n_tokens: int
    space_lesson: str | None = None
    """When the text is a single word: how ' word' vs 'word' tokenize —
    the leading-space footgun, institutionalized."""

    stub: bool = False
    note: str | None = None


@router.post("/tokenize")
async def tokenize(req: TokenizeRequest) -> TokenizeResponse:
    """Show exactly what the model sees: token boundaries, ids, and bytes.

    Tokenization is where most 'the model is being weird' mysteries live —
    numbers fragment, a leading space changes everything, rare words shatter.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_tokenize(bridge, req)
    except ImportError as e:
        logger.info("tokenize degrading to stub: %s", e)
        return _stub_tokenize(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("tokenize model load failed: %s", e)
        return _stub_tokenize(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("tokenize unexpected error")
        return _stub_tokenize(req, note=f"unexpected error: {e}")


def _real_tokenize(bridge: TransformerBridge, req: TokenizeRequest) -> TokenizeResponse:
    ids = bridge.to_tokens(req.prompt, prepend_bos=False)[0]
    toks = [
        TokenInfo(
            token=bridge.to_string([int(i)]),
            id=int(i),
            n_bytes=len(bridge.to_string([int(i)]).encode()),
        )
        for i in ids
    ]

    space_lesson: str | None = None
    word = req.prompt.strip()
    if word and " " not in word:
        bare = bridge.to_tokens(word, prepend_bos=False)[0]
        spaced = bridge.to_tokens(" " + word, prepend_bos=False)[0]
        bare_s = " + ".join(repr(bridge.to_string([int(i)])) for i in bare)
        spaced_s = " + ".join(repr(bridge.to_string([int(i)])) for i in spaced)
        space_lesson = (
            f"'{word}' -> {len(bare)} token(s): {bare_s}   vs   "
            f"' {word}' (leading space) -> {len(spaced)} token(s): {spaced_s}. "
            "Mid-sentence words carry the space — probing with the bare form "
            "asks about a different token."
        )

    return TokenizeResponse(
        model_id=req.model_id,
        tokens=toks,
        n_tokens=len(toks),
        space_lesson=space_lesson,
        stub=False,
    )


def _stub_tokenize(req: TokenizeRequest, *, note: str) -> TokenizeResponse:
    words = req.prompt.split()[:16] or ["<bos>"]
    toks = [TokenInfo(token=w, id=1000 + i, n_bytes=len(w.encode())) for i, w in enumerate(words)]
    return TokenizeResponse(
        model_id=req.model_id, tokens=toks, n_tokens=len(toks), stub=True, note=note
    )


# ----- head census: score every head for known signatures ----------------------


class HeadCensusRequest(BaseModel):
    model_id: str


class CensusHead(BaseModel):
    layer: int
    head: int
    score: float


class HeadCensusResponse(BaseModel):
    model_id: str
    n_layers: int
    n_heads: int
    prev_token: list[list[float]]
    """[L][H] — mean attention to the immediately previous position."""

    induction: list[list[float]]
    """[L][H] — repeated-random-sequence induction score (attend to the token
    AFTER the previous occurrence of the current token)."""

    sink: list[list[float]]
    """[L][H] — mean attention parked on position 0 (the attention sink)."""

    top: dict[str, list[CensusHead]]
    stub: bool = False
    note: str | None = None


@router.post("/head_census")
async def head_census(req: HeadCensusRequest) -> HeadCensusResponse:
    """Census all heads at once: previous-token, induction, and sink scores.

    Prompt-independent (runs on a fixed random repeated sequence — the classic
    induction test) so it characterizes the MODEL, not one input. The heads
    the first-run intro sends you hunting for are provable here.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_head_census(bridge, req)
    except ImportError as e:
        logger.info("head_census degrading to stub: %s", e)
        return _stub_head_census(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("head_census model load failed: %s", e)
        return _stub_head_census(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("head_census unexpected error")
        return _stub_head_census(req, note=f"unexpected error: {e}")


_census_cache: dict[str, HeadCensusResponse] = {}

_CENSUS_HALF_LEN = 50  # random-sequence half-length for the induction test


def _real_head_census(bridge: TransformerBridge, req: HeadCensusRequest) -> HeadCensusResponse:
    if req.model_id in _census_cache:
        return _census_cache[req.model_id]

    import torch

    n_layers = int(bridge.cfg.n_layers)
    n_heads = int(bridge.cfg.n_heads)
    d_vocab = int(bridge.cfg.d_vocab)

    # Deterministic random sequence, repeated: [bos, A, A].
    g = torch.Generator().manual_seed(42)
    half = torch.randint(1000, d_vocab - 1000, (1, _CENSUS_HALF_LEN), generator=g)
    bos_id = bridge.tokenizer.bos_token_id
    bos = torch.tensor([[bos_id if bos_id is not None else 50256]])
    seq = torch.cat([bos, half, half], dim=1).to(next(bridge.parameters()).device)

    _, cache = bridge.run_with_cache(seq)
    T = seq.shape[1]
    second_half = range(_CENSUS_HALF_LEN + 1, T)  # positions in the repeat

    prev_g: list[list[float]] = []
    ind_g: list[list[float]] = []
    sink_g: list[list[float]] = []
    for layer in range(n_layers):
        pattern = cache[f"blocks.{layer}.attn.hook_pattern"][0]  # [H, T, T]
        prev_row, ind_row, sink_row = [], [], []
        for h in range(n_heads):
            p = pattern[h]
            prev_row.append(float(torch.stack([p[i, i - 1] for i in range(1, T)]).mean()))
            # induction target: the token AFTER the previous occurrence of the
            # current token — exactly one period back, plus one.
            ind_row.append(
                float(torch.stack([p[i, i - _CENSUS_HALF_LEN + 1] for i in second_half]).mean())
            )
            sink_row.append(float(p[1:, 0].mean()))
        prev_g.append([round(v, 4) for v in prev_row])
        ind_g.append([round(v, 4) for v in ind_row])
        sink_g.append([round(v, 4) for v in sink_row])

    def top5(grid: list[list[float]]) -> list[CensusHead]:
        flat = [
            CensusHead(layer=layer, head=h, score=grid[layer][h])
            for layer in range(n_layers)
            for h in range(n_heads)
        ]
        return sorted(flat, key=lambda x: -x.score)[:5]

    resp = HeadCensusResponse(
        model_id=req.model_id,
        n_layers=n_layers,
        n_heads=n_heads,
        prev_token=prev_g,
        induction=ind_g,
        sink=sink_g,
        top={"prev_token": top5(prev_g), "induction": top5(ind_g), "sink": top5(sink_g)},
        stub=False,
    )
    _census_cache[req.model_id] = resp
    return resp


def _stub_head_census(req: HeadCensusRequest, *, note: str) -> HeadCensusResponse:
    L, H = 12, 12
    zeros = [[0.05 for _ in range(H)] for _ in range(L)]
    prev = [row[:] for row in zeros]
    ind = [row[:] for row in zeros]
    sink = [row[:] for row in zeros]
    prev[4][11] = 0.9
    ind[5][5] = 0.7
    sink[0][3] = 0.8
    return HeadCensusResponse(
        model_id=req.model_id,
        n_layers=L,
        n_heads=H,
        prev_token=prev,
        induction=ind,
        sink=sink,
        top={
            "prev_token": [CensusHead(layer=4, head=11, score=0.9)],
            "induction": [CensusHead(layer=5, head=5, score=0.7)],
            "sink": [CensusHead(layer=0, head=3, score=0.8)],
        },
        stub=True,
        note=note,
    )


# ----- input saliency: which words did it use? ---------------------------------


class SaliencyRequest(BaseModel):
    model_id: str
    prompt: str
    answer: str | None = None
    """Target token. Empty -> the model's own top-1 prediction."""


class SaliencyResponse(BaseModel):
    model_id: str
    tokens: list[str]
    saliency: list[float]
    """Gradient L2 norm per input token: how sensitive the target logit is
    to that token's embedding. (grad x input was tested and is unfaithful
    here — LayerNorm-induced cancellations buried the Eiffel tokens.)"""

    target: str
    stub: bool = False
    note: str | None = None


@router.post("/saliency")
async def saliency(req: SaliencyRequest) -> SaliencyResponse:
    """Gradient-norm attribution over the INPUT tokens.

    The first causal question everyone asks — 'which words did it use?' —
    answered with one backward pass: how strongly the target logit reacts
    to wiggling each input token's embedding.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_saliency(bridge, req)
    except ImportError as e:
        logger.info("saliency degrading to stub: %s", e)
        return _stub_saliency(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("saliency model load failed: %s", e)
        return _stub_saliency(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("saliency unexpected error")
        return _stub_saliency(req, note=f"unexpected error: {e}")


def _real_saliency(bridge: TransformerBridge, req: SaliencyRequest) -> SaliencyResponse:
    import torch

    tokens = bridge.to_tokens(req.prompt)

    captured: dict[str, Any] = {}

    def grab(value: Any, hook: Any) -> Any:
        value.retain_grad()
        captured["embed"] = value
        return value

    with torch.enable_grad():
        logits = bridge.run_with_hooks(tokens, fwd_hooks=[("hook_embed", grab)])[0, -1]
        if req.answer and req.answer.strip():
            target_id = _to_id(bridge, req.answer)
        else:
            target_id = int(logits.argmax())
        logits[target_id].backward()

    grad = captured["embed"].grad[0]  # [T, d]
    scores = grad.float().norm(dim=-1)

    return SaliencyResponse(
        model_id=req.model_id,
        tokens=list(bridge.to_str_tokens(req.prompt)),
        saliency=[round(float(v), 4) for v in scores],
        target=bridge.to_string([target_id]),
        stub=False,
    )


def _stub_saliency(req: SaliencyRequest, *, note: str) -> SaliencyResponse:
    words = req.prompt.split()[:16] or ["<bos>"]
    vals = [round(0.5 + ((i * 7) % 5) / 2.0, 2) for i in range(len(words))]
    return SaliencyResponse(
        model_id=req.model_id,
        tokens=words,
        saliency=vals,
        target=req.answer or " the",
        stub=True,
        note=note,
    )


# ----- weight lens: read a neuron's weights, no forward pass -------------------


class WeightLensRequest(BaseModel):
    model_id: str
    layer: int = Field(..., ge=0)
    unit: int = Field(..., ge=0)
    top_k: int = Field(default=8, ge=1, le=20)


class WeightLensResponse(BaseModel):
    model_id: str
    layer: int
    unit: int
    reads: list[TopToken]
    """Tokens whose EMBEDDINGS most excite this neuron — cosine similarity
    against W_in (raw dot products surface glitch tokens with degenerate
    norms; cosine was verified to fix that)."""

    promotes: list[TopToken]
    """Tokens this neuron pushes UP when it fires (W_out through W_U)."""

    suppresses: list[TopToken]
    """Tokens this neuron pushes DOWN when it fires."""

    stub: bool = False
    note: str | None = None


@router.post("/weight_lens")
async def weight_lens(req: WeightLensRequest) -> WeightLensResponse:
    """What a neuron IS, read from its weights alone — zero forward passes.

    Activations tell you what happened on one prompt; weights tell you what
    the component is wired to do on every prompt: which token embeddings
    excite it (its input direction through W_E) and which tokens it promotes
    or suppresses when it fires (its output direction through W_U).
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_weight_lens(bridge, req)
    except ImportError as e:
        logger.info("weight_lens degrading to stub: %s", e)
        return _stub_weight_lens(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("weight_lens model load failed: %s", e)
        return _stub_weight_lens(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("weight_lens unexpected error")
        return _stub_weight_lens(req, note=f"unexpected error: {e}")


def _real_weight_lens(bridge: TransformerBridge, req: WeightLensRequest) -> WeightLensResponse:
    import torch

    w_in = bridge.W_in[req.layer, :, req.unit].float()  # [d_model]
    w_out = bridge.W_out[req.layer, req.unit].float()  # [d_model]
    W_E = bridge.W_E.float()  # [vocab, d_model]
    W_U = bridge.W_U.float()  # [d_model, vocab]

    def toplist(scores: Any, k: int, largest: bool = True) -> list[TopToken]:
        top = torch.topk(scores, k=k, largest=largest)
        return [
            TopToken(token=bridge.to_string([int(i)]), logit=float(v), prob=0.0)
            for v, i in zip(top.values, top.indices, strict=True)
        ]

    with torch.no_grad():
        cos = (W_E / W_E.norm(dim=-1, keepdim=True)) @ (w_in / w_in.norm())
        reads = toplist(cos, req.top_k)
        out_logits = w_out @ W_U
        promotes = toplist(out_logits, req.top_k)
        suppresses = toplist(out_logits, req.top_k, largest=False)

    return WeightLensResponse(
        model_id=req.model_id,
        layer=req.layer,
        unit=req.unit,
        reads=reads,
        promotes=promotes,
        suppresses=suppresses,
        stub=False,
    )


def _stub_weight_lens(req: WeightLensRequest, *, note: str) -> WeightLensResponse:
    mk = lambda toks: [TopToken(token=t, logit=5.0 - i, prob=0.0) for i, t in enumerate(toks)]  # noqa: E731
    return WeightLensResponse(
        model_id=req.model_id,
        layer=req.layer,
        unit=req.unit,
        reads=mk([" red", " blue", " green"][: req.top_k]),
        promotes=mk([" color", " paint", " hue"][: req.top_k]),
        suppresses=mk([" number", " year", " count"][: req.top_k]),
        stub=True,
        note=note,
    )


# ----- max-activating examples: what does this unit fire on, really? -----------


class MaxActivatingRequest(BaseModel):
    model_id: str
    layer: int = Field(..., ge=0)
    unit: int = Field(..., ge=0)
    top_k: int = Field(default=5, ge=1, le=10)


class MaxActivatingExample(BaseModel):
    text: str
    tokens: list[str]
    activations: list[float]
    max_value: float
    max_token: str


class MaxActivatingResponse(BaseModel):
    model_id: str
    layer: int
    unit: int
    examples: list[MaxActivatingExample]
    corpus_size: int = 0
    stub: bool = False
    note: str | None = None


@router.post("/max_activating")
async def max_activating(req: MaxActivatingRequest) -> MaxActivatingResponse:
    """Dataset evidence for a unit: the corpus passages that fire it hardest.

    Weight-lens labels are a prior; this is the ground truth — 'look at your
    data' applied to neurons. Honest scope: the built-in corpus is the
    40-sentence jlens averaging set, so treat results as a first look, not a
    census of everything the unit does.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_max_activating(bridge, req)
    except ImportError as e:
        logger.info("max_activating degrading to stub: %s", e)
        return _stub_max_activating(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("max_activating model load failed: %s", e)
        return _stub_max_activating(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("max_activating unexpected error")
        return _stub_max_activating(req, note=f"unexpected error: {e}")


def _real_max_activating(
    bridge: TransformerBridge, req: MaxActivatingRequest
) -> MaxActivatingResponse:
    from mi_backend.models import jlens_runtime

    corpus = jlens_runtime._corpus()  # the vendored 40-sentence set
    hook = f"blocks.{req.layer}.mlp.hook_post"

    scored: list[MaxActivatingExample] = []
    for line in corpus:
        _, cache = bridge.run_with_cache(bridge.to_tokens(line))
        acts = cache[hook][0][:, req.unit]
        toks = list(bridge.to_str_tokens(line))
        vals = [round(float(v), 3) for v in acts]
        mi = int(acts.argmax())
        scored.append(
            MaxActivatingExample(
                text=line,
                tokens=toks,
                activations=vals,
                max_value=vals[mi],
                max_token=toks[mi],
            )
        )
    scored.sort(key=lambda e: -e.max_value)

    return MaxActivatingResponse(
        model_id=req.model_id,
        layer=req.layer,
        unit=req.unit,
        examples=scored[: req.top_k],
        corpus_size=len(corpus),
        stub=False,
    )


def _stub_max_activating(req: MaxActivatingRequest, *, note: str) -> MaxActivatingResponse:
    ex = MaxActivatingExample(
        text="The quick brown fox",
        tokens=["The", " quick", " brown", " fox"],
        activations=[0.1, 0.4, 2.5, 0.3],
        max_value=2.5,
        max_token=" brown",
    )
    return MaxActivatingResponse(
        model_id=req.model_id,
        layer=req.layer,
        unit=req.unit,
        examples=[ex] * min(req.top_k, 2),
        corpus_size=0,
        stub=True,
        note=note,
    )


# ----- model diff: same prompt, two brains --------------------------------------


class ModelDiffRequest(BaseModel):
    model_id: str
    model_b: str = "distilgpt2"
    prompt: str
    top_k: int = Field(default=6, ge=1, le=15)


class ModelDiffResponse(BaseModel):
    model_id: str
    model_b: str
    tokens: list[str]
    surprisal_a: list[float]
    surprisal_b: list[float]
    """Per-token surprisal (bits) under each model; first token neutral 0."""

    top_a: list[TopToken]
    top_b: list[TopToken]
    stub: bool = False
    note: str | None = None


@router.post("/model_diff")
async def model_diff(req: ModelDiffRequest) -> ModelDiffResponse:
    """Same prompt, two models: per-token surprisal side by side + next-token
    predictions. Where the small model is confused and the big one is calm is
    exactly what the extra parameters bought.

    Requires both models to share a tokenizer (gpt2 family does); refuses
    honestly otherwise.
    """
    try:
        from mi_backend.models import loader

        bridge_a: TransformerBridge = loader.get_model(req.model_id)
        bridge_b: TransformerBridge = loader.get_model(req.model_b)
        return _real_model_diff(bridge_a, bridge_b, req)
    except ImportError as e:
        logger.info("model_diff degrading to stub: %s", e)
        return _stub_model_diff(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("model_diff model load failed: %s", e)
        return _stub_model_diff(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("model_diff unexpected error")
        return _stub_model_diff(req, note=f"unexpected error: {e}")


def _surprisal_bits(bridge: TransformerBridge, prompt: str) -> tuple[list[str], list[float]]:
    import math

    import torch

    tokens = bridge.to_tokens(prompt)
    logprobs = torch.log_softmax(bridge(tokens)[0].float(), dim=-1)
    strs = list(bridge.to_str_tokens(prompt))
    bits = [0.0] + [
        round(float(-logprobs[t - 1, tokens[0, t]] / math.log(2)), 3)
        for t in range(1, len(strs))
    ]
    return strs, bits


def _next_topk(bridge: TransformerBridge, prompt: str, k: int) -> list[TopToken]:
    import torch

    logits = bridge(bridge.to_tokens(prompt))[0, -1].float()
    probs = torch.softmax(logits, dim=-1)
    top = torch.topk(logits, k=k)
    return [
        TopToken(token=bridge.to_string([int(i)]), logit=float(v), prob=float(probs[i]))
        for v, i in zip(top.values, top.indices, strict=True)
    ]


def _real_model_diff(
    bridge_a: TransformerBridge, bridge_b: TransformerBridge, req: ModelDiffRequest
) -> ModelDiffResponse:
    toks_a, bits_a = _surprisal_bits(bridge_a, req.prompt)
    toks_b, bits_b = _surprisal_bits(bridge_b, req.prompt)
    if toks_a != toks_b:
        raise RuntimeError(
            f"'{req.model_id}' and '{req.model_b}' tokenize this prompt differently — "
            "a per-token diff would compare apples to oranges. Use same-family models."
        )
    return ModelDiffResponse(
        model_id=req.model_id,
        model_b=req.model_b,
        tokens=toks_a,
        surprisal_a=bits_a,
        surprisal_b=bits_b,
        top_a=_next_topk(bridge_a, req.prompt, req.top_k),
        top_b=_next_topk(bridge_b, req.prompt, req.top_k),
        stub=False,
    )


def _stub_model_diff(req: ModelDiffRequest, *, note: str) -> ModelDiffResponse:
    words = req.prompt.split()[:12] or ["<bos>"]
    a = [0.0] + [round(2.0 + (i % 4), 2) for i in range(len(words) - 1)]
    b = [0.0] + [round(3.5 + ((i + 1) % 4), 2) for i in range(len(words) - 1)]
    mk = lambda t, p: TopToken(token=t, logit=5.0, prob=p)  # noqa: E731
    return ModelDiffResponse(
        model_id=req.model_id,
        model_b=req.model_b,
        tokens=words,
        surprisal_a=a,
        surprisal_b=b,
        top_a=[mk(" Paris", 0.4), mk(" the", 0.1)][: req.top_k],
        top_b=[mk(" the", 0.2), mk(" Paris", 0.1)][: req.top_k],
        stub=True,
        note=note,
    )


# ----- J-lens paper tools ------------------------------------------------------
#
# From "Verbalizable Representations Form a Global Workspace in Language
# Models" (Gurnee, Sofroniew, Lindsey et al., Transformer Circuits 2026):
# pinned-token rank heatmaps, the lens-coordinate swap intervention, the
# concept-set score, and per-model workspace-band statistics. The companion
# repo ships only lens machinery — the interventions are implemented here
# from the paper's Methods section.


class JlensReadyRequest(BaseModel):
    model_id: str


class JlensReadyResponse(BaseModel):
    model_id: str
    warm: bool
    """True when this process already holds the model's Reader (instant probes).
    False = the next J-lens probe builds or disk-loads the Jacobian first."""


@router.post("/jlens_ready")
async def jlens_ready(req: JlensReadyRequest) -> JlensReadyResponse:
    """Cheap warmth check so the UI can set honest expectations before a
    J-lens probe: warm -> instant; cold -> up to a couple of minutes once."""
    try:
        from mi_backend.models import jlens_runtime, loader

        hf_id = loader._canonical_repo_id(req.model_id)
        return JlensReadyResponse(model_id=req.model_id, warm=hf_id in jlens_runtime._readers)
    except Exception:
        return JlensReadyResponse(model_id=req.model_id, warm=False)


class JlensPinnedRequest(BaseModel):
    model_id: str
    prompt: str
    pinned: list[str] = Field(..., min_length=1, max_length=8)


class JlensPinnedResponse(BaseModel):
    model_id: str
    tokens: list[str]
    layers: list[int]
    layer_pct: list[int]
    ranks: dict[str, list[list[int]]]
    """ranks[token][layer_idx][pos] = rank of that token in the lens (1 = top)."""

    stub: bool = False
    note: str | None = None


@router.post("/jlens_pinned")
async def jlens_pinned(req: JlensPinnedRequest) -> JlensPinnedResponse:
    """Pinned-token rank heatmap — the paper's core exploration affordance."""
    try:
        from mi_backend.models import jlens_runtime, loader

        hf_id = loader._canonical_repo_id(req.model_id)
        d = jlens_runtime.pinned_ranks(hf_id, req.prompt, req.pinned)
        return JlensPinnedResponse(model_id=req.model_id, stub=False, **d)
    except Exception as e:
        logger.exception("jlens_pinned failed")
        return JlensPinnedResponse(
            model_id=req.model_id, tokens=[], layers=[], layer_pct=[], ranks={},
            stub=True, note=f"jlens pinned ranks unavailable: {e}",
        )


class JlensSwapRequest(BaseModel):
    model_id: str
    prompt: str
    source: str = Field(..., description="concept currently in the workspace")
    target: str = Field(..., description="concept to swap in")
    alpha: float = Field(default=1.0, ge=0.25, le=3.0)
    max_new_tokens: int = Field(default=12, ge=1, le=40)


class JlensSwapResponse(BaseModel):
    model_id: str
    source: str
    target: str
    band_pct: list[int]
    clean: str
    swapped: str
    stub: bool = False
    note: str | None = None


@router.post("/jlens_swap")
async def jlens_swap(req: JlensSwapRequest) -> JlensSwapResponse:
    """Lens-coordinate swap + generate — the paper's causal workhorse.

    h_patched = h + V(sigma(c) - c) with c = V^+ h, applied at every position
    over the workspace layer band; then greedy-generate and compare clean vs
    swapped continuations.
    """
    try:
        from mi_backend.models import jlens_runtime, loader

        hf_id = loader._canonical_repo_id(req.model_id)
        d = jlens_runtime.swap_generate(
            hf_id, req.prompt, req.source, req.target,
            alpha=req.alpha, max_new_tokens=req.max_new_tokens,
        )
        return JlensSwapResponse(
            model_id=req.model_id, source=d["source"], target=d["target"],
            band_pct=d["band_pct"], clean=d["clean"], swapped=d["swapped"], stub=False,
        )
    except Exception as e:
        logger.exception("jlens_swap failed")
        return JlensSwapResponse(
            model_id=req.model_id, source=req.source, target=req.target,
            band_pct=[], clean="", swapped="", stub=True,
            note=f"jlens swap unavailable: {e}",
        )


class JlensStatsRequest(BaseModel):
    model_id: str


class JlensStatsResponse(BaseModel):
    model_id: str
    layers: list[int]
    layer_pct: list[int]
    kurtosis: list[float]
    """Excess kurtosis of lens logits per layer — near zero = no content (pre-workspace)."""

    output_agreement: list[float]
    """Top-1 agreement with the model's true next token — high = 'motor' regime."""

    stub: bool = False
    note: str | None = None


@router.post("/jlens_stats")
async def jlens_stats(req: JlensStatsRequest) -> JlensStatsResponse:
    """Per-model workspace-band statistics (paper's layer-regime metrics)."""
    try:
        from mi_backend.models import jlens_runtime, loader

        hf_id = loader._canonical_repo_id(req.model_id)
        d = jlens_runtime.workspace_stats(hf_id)
        return JlensStatsResponse(model_id=req.model_id, stub=False, **d)
    except Exception as e:
        logger.exception("jlens_stats failed")
        return JlensStatsResponse(
            model_id=req.model_id, layers=[], layer_pct=[], kurtosis=[],
            output_agreement=[], stub=True, note=f"jlens stats unavailable: {e}",
        )


# ----- concept direction (Features) ------------------------------------------
#
# Ported from belief-lab's contrast probe (embed_validate.py): the training-free
# difference-of-means primitive cos(x, pos) - cos(x, neg). belief-lab ran it on
# an EXTERNAL embedding space (nomic-embed-text); here it runs on the target
# model's OWN residual stream, per layer — the jlens+belief-lab fusion the
# MI_WORKBENCH_INTAKE note names: the first true activation probe.


class ConceptDirectionRequest(BaseModel):
    model_id: str
    prompt: str  # the text to score
    pos_prompts: list[str] = Field(..., min_length=1, description="examples OF the concept")
    neg_prompts: list[str] = Field(..., min_length=1, description="examples of its contrast")


class ConceptDirectionResponse(BaseModel):
    model_id: str
    n_layers: int
    scores: list[float]
    """scores[layer] = cos(test, pos centroid) - cos(test, neg centroid) at that layer."""

    best_layer: int
    best_score: float
    stub: bool = False
    note: str | None = None


@router.post("/concept_direction")
async def concept_direction(req: ConceptDirectionRequest) -> ConceptDirectionResponse:
    """Score a prompt against a concept direction, at every layer.

    Build a centroid from the positive examples' residuals and one from the
    negatives, then score the test prompt's residual against the difference —
    per layer. Where the score comes apart from zero is where the model has
    STARTED representing the distinction. Training-free; more examples per side
    = a cleaner direction.
    """
    try:
        from mi_backend.models import loader

        bridge: TransformerBridge = loader.get_model(req.model_id)
        return _real_concept_direction(bridge, req)
    except ImportError as e:
        logger.info("concept_direction degrading to stub: %s", e)
        return _stub_concept_direction(req, note="transformer-lens not installed")
    except RuntimeError as e:
        logger.warning("concept_direction model load failed: %s", e)
        return _stub_concept_direction(req, note=f"model load failed: {e}")
    except Exception as e:
        logger.exception("concept_direction unexpected error")
        return _stub_concept_direction(req, note=f"unexpected error: {e}")


def _resid_stack(bridge: TransformerBridge, text: str, n_layers: int) -> Any:
    """Last-token residual at every layer: [n_layers, d_model]."""
    import torch

    _, cache = bridge.run_with_cache(bridge.to_tokens(text))
    return torch.stack(
        [cache[f"blocks.{layer}.hook_resid_post"][0, -1] for layer in range(n_layers)]
    )


def _real_concept_direction(
    bridge: TransformerBridge, req: ConceptDirectionRequest
) -> ConceptDirectionResponse:
    import torch

    n_layers = int(bridge.cfg.n_layers)
    # Per-layer centroids over each side's examples (difference-of-means).
    pos = torch.stack([_resid_stack(bridge, t, n_layers) for t in req.pos_prompts]).mean(dim=0)
    neg = torch.stack([_resid_stack(bridge, t, n_layers) for t in req.neg_prompts]).mean(dim=0)
    test = _resid_stack(bridge, req.prompt, n_layers)

    # Center the test point at the two sides' midpoint, then measure its
    # alignment with the concept AXIS (pos - neg). Raw cosines between full
    # residuals are ~0.99 for any two sentences (shared position/syntax mass
    # dominates); centering cancels that shared component so only the
    # concept-relevant part is scored.
    cos = torch.nn.functional.cosine_similarity
    mid = (pos + neg) / 2
    axis = pos - neg
    scores = [float(cos(test[L] - mid[L], axis[L], dim=0)) for L in range(n_layers)]

    best_layer = max(range(n_layers), key=lambda L: abs(scores[L]))
    return ConceptDirectionResponse(
        model_id=req.model_id,
        n_layers=n_layers,
        scores=scores,
        best_layer=best_layer,
        best_score=scores[best_layer],
        stub=False,
    )


def _stub_concept_direction(
    req: ConceptDirectionRequest, *, note: str
) -> ConceptDirectionResponse:
    import math

    n_layers = 12
    # Fake emergence curve: near zero early, rising through the middle layers.
    scores = [round(0.35 / (1 + math.exp(-(layer - 6))), 4) for layer in range(n_layers)]
    best_layer = n_layers - 1
    return ConceptDirectionResponse(
        model_id=req.model_id,
        n_layers=n_layers,
        scores=scores,
        best_layer=best_layer,
        best_score=scores[best_layer],
        stub=True,
        note=note,
    )


def _stub_neurons(req: NeuronFiringsRequest, *, note: str) -> NeuronFiringsResponse:
    import math

    toks = req.prompt.split()[:6] or ["<bos>"]
    firings = [
        NeuronFiring(
            position=i % len(toks),
            token=toks[i % len(toks)],
            neuron=1000 + i * 137,
            activation=round(8.0 * math.exp(-i / 5), 3),
        )
        for i in range(min(req.top_k, 12))
    ]
    return NeuronFiringsResponse(
        model_id=req.model_id, layer=req.layer, d_mlp=3072, firings=firings, stub=True, note=note
    )
