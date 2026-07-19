"""Health endpoints — liveness + readiness.

V1: both are trivially OK. V2+ readiness will check that the default model
can be loaded (returns DEGRADED if not, with a remediation hint).
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/live")
async def live() -> dict[str, str]:
    """Liveness probe — is the process up?"""
    return {"status": "ok"}


@router.get("/ready")
async def ready() -> dict[str, str]:
    """Readiness probe — is the service ready to serve requests?"""
    # V1: always ready. V2+: check model registry + (optional) preloaded model.
    return {"status": "ok"}
