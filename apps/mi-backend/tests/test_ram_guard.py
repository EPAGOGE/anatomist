"""RAM guard: a load that would OOM the process must refuse honestly instead.

The gemma-2-2b lesson enforced: compat-mode conversion peaks at ~8 bytes/param
(measured — a 2.6B model OOM'd at ~20 GB on a 16 GB machine while the old fp16
heuristic said 7.7 GB "fits"). The guard runs BEFORE torch imports, so these
tests run in the torch-free CI tier.
"""

from __future__ import annotations

import sys
import types

import pytest

from mi_backend.models import loader, registry


def test_fits_locally_uses_measured_peak() -> None:
    gemma = registry.get_by_id("gemma-2-2b-it")
    gpt2 = registry.get_by_id("gpt2")
    assert gemma is not None and gpt2 is not None
    # 16 GB machine with 10 GB free: gemma (needs ~23 GB) must NOT fit…
    assert registry.fits_locally(gemma, available_ram_gb=10.0) is False
    # …while gpt2 (needs ~3 GB) does.
    assert registry.fits_locally(gpt2, available_ram_gb=10.0) is True


def test_loader_refuses_oversized_model_before_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    """With low reported memory, get_model raises the honest RuntimeError
    without ever reaching the heavy-import path — provable because this test
    passes in an environment with no torch installed."""
    fake_psutil = types.SimpleNamespace(
        virtual_memory=lambda: types.SimpleNamespace(available=4 * 10**9)  # 4 GB
    )
    monkeypatch.setitem(sys.modules, "psutil", fake_psutil)

    with pytest.raises(RuntimeError, match="Refusing to load"):
        loader.get_model("gemma-2-2b-it")


def test_loader_skips_guard_for_unknown_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """Models outside the catalog can't be estimated — the guard must NOT
    block them (it degrades; the load path itself reports real failures)."""
    fake_psutil = types.SimpleNamespace(
        virtual_memory=lambda: types.SimpleNamespace(available=1 * 10**9)  # 1 GB
    )
    monkeypatch.setitem(sys.modules, "psutil", fake_psutil)

    # Unknown model: guard passes; the subsequent import/load raises SOMETHING
    # else (ImportError without ml deps, RuntimeError on load failure) — but
    # never the guard's "Refusing to load" message.
    with pytest.raises(Exception) as exc_info:
        loader.get_model("totally/unknown-model-id")
    assert "Refusing to load" not in str(exc_info.value)
