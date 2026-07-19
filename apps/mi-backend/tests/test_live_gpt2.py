"""Live tier: real gpt2, real probes. Run explicitly with `pytest -m live`.

Requires the [ml] extra and gpt2 weights (network or HF cache). The canary
here is the same instrument self-test the UI exposes — in CI-of-the-future
with weights cached, this is the "the tool is not lying" gate.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.live


@pytest.fixture(scope="module", autouse=True)
def gpt2_loaded(client: TestClient) -> None:
    res = client.post("/models/gpt2/load", json={})
    assert res.status_code == 200, res.text


def test_canary_verifies_instrument(client: TestClient) -> None:
    data = client.post("/probe/canary", json={"model_id": "gpt2"}).json()
    assert data["stub"] is False
    assert data["verdict"] == "verified", data["checks"]


def test_attention_pattern_is_real_and_causal(client: TestClient) -> None:
    data = client.post(
        "/probe/attention_pattern",
        json={"model_id": "gpt2", "prompt": "The capital of France is", "layer": 0, "head": 0},
    ).json()
    assert data["stub"] is False
    pattern = data["pattern"]
    # causal: strictly-upper entries ~0; rows sum to ~1
    for i, row in enumerate(pattern):
        assert all(abs(v) < 1e-4 for v in row[i + 1 :])
        assert abs(sum(row) - 1.0) < 1e-3
