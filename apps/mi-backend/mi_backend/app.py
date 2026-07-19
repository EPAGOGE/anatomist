"""FastAPI app factory.

Composes routes for the MI Workbench subsystems:
- /health   liveness/readiness
- /models   model library catalog (Subsystem 1)
- /chat     model chat with activation capture (Subsystem 4) — WebSocket
- /probe    MI Toolchest button endpoints (Subsystem 3)

V1 scope: routes wired, model loading stubbed (returns mock data when
transformer-lens isn't installed). Once ML deps land and HF_TOKEN is
provided, /probe and /chat switch to real model execution.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mi_backend.config import get_settings
from mi_backend.routes import chat, frontier, health, models, probe

# OPTIONAL private extension: GameFormer 526M grounded readings. Deleting the
# gameformer_ext folder removes the /grounded routes and nothing else.
try:
    from mi_backend.gameformer_ext import routes as gameformer_ext_routes
except ImportError:
    gameformer_ext_routes = None  # type: ignore[assignment]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """App lifespan — model registry loaded eagerly; model weights lazily."""
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Anatomist Backend",
        version="0.1.0",
        description=(
            "Visual mechanistic interpretability workbench — backend service. "
            "Loads models via TransformerLens, exposes MI toolchest endpoints."
        ),
        lifespan=lifespan,
    )

    # CORS — the web frontend (apps/web) runs at a different origin
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router, prefix="/health", tags=["health"])
    app.include_router(models.router, prefix="/models", tags=["models"])
    app.include_router(chat.router, prefix="/chat", tags=["chat"])
    app.include_router(probe.router, prefix="/probe", tags=["probe"])
    if gameformer_ext_routes is not None:
        app.include_router(gameformer_ext_routes.router, prefix="/grounded", tags=["grounded"])
    app.include_router(frontier.router, prefix="/frontier", tags=["frontier"])

    return app
