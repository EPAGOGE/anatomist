"""MI Workbench backend entry point.

Run locally:
    cd apps/mi-backend
    python3 -m venv .venv && source .venv/bin/activate
    pip install -e .
    cp .env.example .env  # edit to add HF_TOKEN if loading gated models
    uvicorn main:app --reload --port 8765

Or directly:
    python main.py
"""

from __future__ import annotations

import uvicorn

from mi_backend.app import create_app
from mi_backend.config import get_settings

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
