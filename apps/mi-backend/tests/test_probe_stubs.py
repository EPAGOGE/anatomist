"""Every probe endpoint must honor the degrade-to-stub contract.

With model loading blocked, each endpoint returns 200 with stub=true and an
honest note — never a 500, never fabricated data presented as real. This is
the whole-workbench guarantee that lets the frontend build/run without ML
deps, and it runs in CI with the base install only.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

CASES: list[tuple[str, dict]] = [
    ("/probe/attention_pattern", {"model_id": "gpt2", "prompt": "a b c", "layer": 0, "head": 0}),
    ("/probe/activations", {"model_id": "gpt2", "prompt": "a b c", "layer": 0}),
    ("/probe/logit_lens", {"model_id": "gpt2", "prompt": "a b c", "layer": 0}),
    ("/probe/next_tokens", {"model_id": "gpt2", "prompt": "a b c"}),
    ("/probe/ablate_head", {"model_id": "gpt2", "prompt": "a b c", "layer": 0, "head": 0}),
    ("/probe/ablate_sweep", {"model_id": "gpt2", "prompt": "a b c"}),
    (
        "/probe/patch",
        {
            "model_id": "gpt2",
            "clean_prompt": "a b c",
            "corrupted_prompt": "a b d",
            "answer": " x",
            "corrupted_answer": " y",
        },
    ),
    (
        "/probe/logit_attribution",
        {"model_id": "gpt2", "prompt": "a b c", "answer": " x", "corrupted_answer": " y"},
    ),
    ("/probe/neurons", {"model_id": "gpt2", "prompt": "a b c", "layer": 0}),
    (
        "/probe/concept_direction",
        {"model_id": "gpt2", "prompt": "a b c", "pos_prompts": ["good"], "neg_prompts": ["bad"]},
    ),
    ("/probe/jlens", {"model_id": "gpt2", "prompt": "a b c"}),
    ("/probe/jlens_pinned", {"model_id": "gpt2", "prompt": "a b c", "pinned": ["x"]}),
    (
        "/probe/jlens_swap",
        {"model_id": "gpt2", "prompt": "a b c", "source": "x", "target": "y"},
    ),
    ("/probe/jlens_stats", {"model_id": "gpt2"}),
    ("/probe/surprisal", {"model_id": "gpt2", "prompt": "a b c"}),
    ("/probe/unit_activation", {"model_id": "gpt2", "prompt": "a b c", "layer": 0, "unit": 5}),
    ("/probe/generate_trace", {"model_id": "gpt2", "prompt": "a b c", "max_new_tokens": 3}),
    ("/probe/tokenize", {"model_id": "gpt2", "prompt": "a b c"}),
    ("/probe/head_census", {"model_id": "gpt2"}),
    ("/probe/saliency", {"model_id": "gpt2", "prompt": "a b c"}),
    ("/probe/weight_lens", {"model_id": "gpt2", "layer": 0, "unit": 5}),
    ("/probe/max_activating", {"model_id": "gpt2", "layer": 0, "unit": 5}),
    ("/probe/model_diff", {"model_id": "gpt2", "prompt": "a b c"}),
    ("/probe/canary", {"model_id": "gpt2"}),
]


@pytest.mark.parametrize(("path", "body"), CASES, ids=[c[0] for c in CASES])
def test_probe_degrades_to_labeled_stub(
    client: TestClient, blocked_models: None, path: str, body: dict
) -> None:
    res = client.post(path, json=body)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["stub"] is True
    assert data.get("note"), "stub responses must say WHY real execution was unavailable"


def test_canary_stub_verdict_is_unknown(client: TestClient, blocked_models: None) -> None:
    data = client.post("/probe/canary", json={"model_id": "gpt2"}).json()
    assert data["verdict"] == "unknown"
    assert data["checks"] and not data["checks"][0]["passed"]


def test_sweep_stub_grid_shape(client: TestClient, blocked_models: None) -> None:
    data = client.post("/probe/ablate_sweep", json={"model_id": "gpt2", "prompt": "a"}).json()
    assert len(data["grid"]) == data["n_layers"]
    assert all(len(row) == data["n_heads"] for row in data["grid"])
    assert data["top_movers"], "stub must still rank movers so the UI renders"


def test_attribution_stub_is_signed(client: TestClient, blocked_models: None) -> None:
    data = client.post(
        "/probe/logit_attribution",
        json={"model_id": "gpt2", "prompt": "a", "answer": " x", "corrupted_answer": " y"},
    ).json()
    flat = [v for row in data["head_grid"] for v in row]
    assert any(v > 0 for v in flat) and any(v < 0 for v in flat), (
        "attribution stub must exercise the diverging (signed) rendering path"
    )


def test_validation_rejects_bad_input(client: TestClient) -> None:
    # Pydantic layer, no model needed: missing required fields -> 422.
    assert client.post("/probe/attention_pattern", json={"model_id": "gpt2"}).status_code == 422
    assert (
        client.post(
            "/probe/jlens_pinned", json={"model_id": "gpt2", "prompt": "a", "pinned": []}
        ).status_code
        == 422
    )


def test_jlens_ready_is_always_answerable(client: TestClient) -> None:
    # Warmth check must never 500 — cold, blocked, or broken all read as warm:false.
    data = client.post("/probe/jlens_ready", json={"model_id": "gpt2"}).json()
    assert data["warm"] is False  # test process never builds a Reader
