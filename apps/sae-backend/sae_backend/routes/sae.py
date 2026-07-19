"""SAE endpoints — same degrade-to-stub contract as the MI backend.

Every endpoint tries real sae_lens execution; on ANY failure (sae_lens not
installed, unsupported model, download failure) it returns clearly-labeled
stub data with an honest note. The UI renders either way.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()


class SaeStatusResponse(BaseModel):
    available: bool
    note: str | None = None


@router.get("/status")
async def status() -> SaeStatusResponse:
    try:
        import sae_lens  # noqa: F401

        return SaeStatusResponse(available=True)
    except ImportError:
        return SaeStatusResponse(
            available=False,
            note="sae_lens not installed in the sidecar venv — pip install -e '.[ml]'",
        )


class FeatureEntry(BaseModel):
    feature: int
    activation: float
    label_tokens: list[str]


class SaeFeaturesRequest(BaseModel):
    model_id: str = "gpt2"
    prompt: str
    layer: int = Field(default=6, ge=0)
    top_k: int = Field(default=10, ge=1, le=30)


class SaeFeaturesResponse(BaseModel):
    model_id: str
    layer: int
    tokens: list[str]
    position: int
    features: list[FeatureEntry]
    fvu: float = 0.0
    l0: float = 0.0
    d_sae: int = 0
    hook_name: str = ""
    stub: bool = False
    note: str | None = None


@router.post("/features")
async def sae_features(req: SaeFeaturesRequest) -> SaeFeaturesResponse:
    """Top SAE features at the final token, self-labeled by promoted tokens."""
    try:
        from sae_backend import runtime

        if not runtime.supported(req.model_id):
            return _stub_features(
                req, note=f"no open SAE weights wired for '{req.model_id}' yet (gpt2 only)"
            )
        d = runtime.features(req.model_id, req.prompt, req.layer, req.top_k)
        return SaeFeaturesResponse(model_id=req.model_id, layer=req.layer, stub=False, **d)
    except ImportError as e:
        logger.info("sae features degrading to stub: %s", e)
        return _stub_features(req, note="sae_lens not installed in the sidecar venv")
    except Exception as e:
        logger.exception("sae features failed")
        return _stub_features(req, note=f"sae features unavailable: {e}")


def _stub_features(req: SaeFeaturesRequest, *, note: str) -> SaeFeaturesResponse:
    toks = req.prompt.split()[:8] or ["<bos>"]
    fillers = [
        (1234, 8.2, [" city", " town", " capital"]),
        (5678, 5.1, [" France", " French", " Paris"]),
        (9012, 3.3, [" the", " a", " an"]),
    ]
    return SaeFeaturesResponse(
        model_id=req.model_id,
        layer=req.layer,
        tokens=toks,
        position=len(toks) - 1,
        features=[
            FeatureEntry(feature=f, activation=a, label_tokens=labels)
            for f, a, labels in fillers[: req.top_k]
        ],
        stub=True,
        note=note,
    )


class TopToken(BaseModel):
    token: str
    logit: float
    prob: float


class SaeAblateRequest(BaseModel):
    model_id: str = "gpt2"
    prompt: str
    layer: int = Field(default=6, ge=0)
    feature: int = Field(..., ge=0)
    top_k: int = Field(default=10, ge=1, le=30)


class SaeAblateResponse(BaseModel):
    model_id: str
    layer: int
    feature: int
    label_tokens: list[str]
    clean_top: list[TopToken]
    ablated_top: list[TopToken]
    stub: bool = False
    note: str | None = None


@router.post("/ablate")
async def sae_ablate(req: SaeAblateRequest) -> SaeAblateResponse:
    """Knock out one learned feature; compare next-token predictions."""
    try:
        from sae_backend import runtime

        if not runtime.supported(req.model_id):
            return _stub_ablate(
                req, note=f"no open SAE weights wired for '{req.model_id}' yet (gpt2 only)"
            )
        d = runtime.ablate_feature(req.model_id, req.prompt, req.layer, req.feature, req.top_k)
        return SaeAblateResponse(model_id=req.model_id, layer=req.layer, stub=False, **d)
    except ImportError as e:
        logger.info("sae ablate degrading to stub: %s", e)
        return _stub_ablate(req, note="sae_lens not installed in the sidecar venv")
    except Exception as e:
        logger.exception("sae ablate failed")
        return _stub_ablate(req, note=f"sae ablation unavailable: {e}")


def _stub_ablate(req: SaeAblateRequest, *, note: str) -> SaeAblateResponse:
    clean = [TopToken(token=t, logit=5.0 - i, prob=0.3 / (i + 1)) for i, t in enumerate(
        [" Paris", " the", " a", " London", " now"][: req.top_k]
    )]
    ablated = [TopToken(token=t, logit=4.5 - i, prob=0.25 / (i + 1)) for i, t in enumerate(
        [" the", " a", " London", " now", " Paris"][: req.top_k]
    )]
    return SaeAblateResponse(
        model_id=req.model_id,
        layer=req.layer,
        feature=req.feature,
        label_tokens=[" city", " place"],
        clean_top=clean,
        ablated_top=ablated,
        stub=True,
        note=note,
    )
