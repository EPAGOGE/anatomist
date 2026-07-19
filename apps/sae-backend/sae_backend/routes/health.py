from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/live")
async def live() -> dict:
    return {"status": "ok"}
