"""The grounded-model (526M) reading endpoints honor the degrade-to-stub
contract: they return honest, structured data with zero ML deps and never a
500. The cached reading is always available; recompute 503s honestly when the
local weights are absent (the CI case). Torch-free, base-install only.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

# Contract tests for the OPTIONAL gameformer_ext module. When the folder is
# deleted (public release), this whole file skips itself — CI stays green.
pytest.importorskip("mi_backend.gameformer_ext")


def test_cached_reading_always_available(client: TestClient) -> None:
    r = client.get("/grounded/526m/reading")
    assert r.status_code == 200
    body = r.json()
    assert body["model_id"] == "epagoge-gf-526m"
    # the load-bearing result is present and shaped
    abl = body["readings"]["ablation_collapse"]
    assert abl["verdict"] == "GROUNDING IS CAUSAL"
    assert abl["g1_grounded"] > abl["g0_ablated"]  # perception ablation collapses it
    assert abl["delta"] > 0.3
    # honesty block is non-empty (the discipline is part of the contract)
    assert isinstance(body["honesty"], list) and body["honesty"]


def test_weights_status_reports_honestly(client: TestClient) -> None:
    r = client.get("/grounded/526m/weights")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"available", "repo_present", "ckpt_present"}
    assert isinstance(body["available"], bool)


def test_recompute_503s_without_weights(client: TestClient) -> None:
    """With no local weights configured (the CI env), recompute must 503 with
    an honest message, never fabricate numbers and never 500."""
    from mi_backend.gameformer_ext import model as gameformer

    if gameformer.weights_available()["available"]:
        # weights present locally — recompute is a live path, not this contract
        return
    r = client.post("/grounded/526m/reading/recompute")
    assert r.status_code == 503
    assert "not available" in r.json()["detail"]


def test_526m_in_catalog(client: TestClient) -> None:
    r = client.get("/models/epagoge-gf-526m")
    assert r.status_code == 200
    entry = r.json()
    assert entry["family"] == "gameformer"
    # custom arch — none of the generic TransformerLens tools claim to work
    assert entry["tools"]["transformer_lens"] is False
