"""Shared fixtures for the mi-backend test suite.

Two tiers:
- Fast tier (default): no model is ever loaded. `blocked_models` forces every
  probe onto its degrade-to-stub path deterministically, so the full HTTP
  contract is testable with zero ML deps — exactly what CI installs.
- Live tier (`pytest -m live`): loads real gpt2 and exercises the real paths.
  Requires the [ml] extra and model weights (network or HF cache).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def client() -> TestClient:
    from main import app

    return TestClient(app)


@pytest.fixture()
def blocked_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force the stub path: model loading and the jlens engine both refuse."""
    from mi_backend.models import jlens_runtime, loader

    def refuse(*_a, **_k):
        raise RuntimeError("blocked by test fixture")

    monkeypatch.setattr(loader, "get_model", refuse)
    monkeypatch.setattr(jlens_runtime, "get_reader", refuse)
