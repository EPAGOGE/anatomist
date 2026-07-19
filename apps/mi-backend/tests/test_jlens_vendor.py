"""The vendored jlens engine must be self-contained in the repo.

Guards ship blocker #1: the J-lens probe must not depend on any path outside
the repository. Pure-stdlib checks — no torch required.
"""

from __future__ import annotations

from pathlib import Path

from mi_backend.models import jlens_runtime

REPO_APP_ROOT = Path(__file__).resolve().parents[1]  # apps/mi-backend


def test_default_engine_path_is_vendored_in_repo() -> None:
    assert jlens_runtime.JLENS_PATH == REPO_APP_ROOT / "vendor" / "jlens"
    assert (jlens_runtime.JLENS_PATH / "jlens" / "__init__.py").exists()


def test_cache_dir_is_inside_repo_and_gitignored_location() -> None:
    assert jlens_runtime.JLENS_CACHE == REPO_APP_ROOT / ".cache" / "jlens"


def test_vendored_corpus_loads(monkeypatch) -> None:
    lines = jlens_runtime._corpus()
    assert len(lines) == 40
    assert all(line.strip() for line in lines)
