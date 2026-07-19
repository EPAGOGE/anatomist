"""SAE sidecar entry point.

Run locally:
    cd apps/sae-backend
    python3.13 -m venv .venv && .venv/bin/pip install -e '.[ml,dev]'
    .venv/bin/uvicorn main:app --port 8766
"""

from __future__ import annotations

import uvicorn

from sae_backend.app import create_app
from sae_backend.config import get_settings

app = create_app()


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
