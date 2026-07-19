"""FastAPI app factory for the SAE sidecar."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sae_backend.config import get_settings
from sae_backend.routes import health, sae


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="SAE Sidecar",
        version="0.1.0",
        description=(
            "Sparse-autoencoder service for the MI Workbench — sae_lens in its own "
            "environment, isolated from the main backend's TransformerLens."
        ),
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health.router, prefix="/health", tags=["health"])
    app.include_router(sae.router, prefix="/sae", tags=["sae"])
    return app
