"""The sidecar honors the same degrade-to-stub contract as the MI backend.

Runs without sae_lens (CI installs base deps only): every endpoint must return
200 + stub:true + an honest note — never a 500, never unlabeled fake data.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def test_health(client: TestClient) -> None:
    assert client.get("/health/live").status_code == 200


def test_status_is_honest(client: TestClient) -> None:
    data = client.get("/sae/status").json()
    assert isinstance(data["available"], bool)
    if not data["available"]:
        assert data["note"]


def test_unsupported_model_degrades_to_stub(client: TestClient) -> None:
    data = client.post(
        "/sae/features", json={"model_id": "some/unwired-model", "prompt": "a b c", "layer": 3}
    ).json()
    assert data["stub"] is True
    assert "no open SAE weights" in (data["note"] or "") or "sae" in (data["note"] or "").lower()


def test_features_stub_when_runtime_blocked(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sae_backend import runtime

    def boom(*_a, **_k):
        raise RuntimeError("blocked by test")

    monkeypatch.setattr(runtime, "features", boom)
    data = client.post("/sae/features", json={"model_id": "gpt2", "prompt": "a", "layer": 6}).json()
    assert data["stub"] is True
    assert data["note"]


def test_ablate_stub_when_runtime_blocked(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sae_backend import runtime

    def boom(*_a, **_k):
        raise RuntimeError("blocked by test")

    monkeypatch.setattr(runtime, "ablate_feature", boom)
    data = client.post(
        "/sae/ablate", json={"model_id": "gpt2", "prompt": "a", "layer": 6, "feature": 1}
    ).json()
    assert data["stub"] is True
    assert data["clean_top"] and data["ablated_top"], "stub must still render the compare UI"


def test_validation_rejects_bad_input(client: TestClient) -> None:
    assert client.post("/sae/ablate", json={"model_id": "gpt2", "prompt": "a"}).status_code == 422
