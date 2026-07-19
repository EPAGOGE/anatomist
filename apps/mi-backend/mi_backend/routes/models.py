"""Model library routes — Subsystem 1.

GET /models               list catalog
GET /models/{id}          single entry
GET /models/{id}/loaded   whether the model is loaded in memory
POST /models/{id}/load    trigger eager load (otherwise loads on first probe)
DELETE /models/{id}       unload from memory
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from mi_backend.models import loader, registry

router = APIRouter()


@router.get("")
async def list_models() -> dict[str, list[registry.ModelEntry]]:
    return {"models": registry.CATALOG}


@router.get("/loaded")
async def get_loaded() -> dict[str, list[str]]:
    """List the model ids currently held in memory."""
    return {"loaded": loader.loaded_models()}


@router.get("/{model_id:path}")
async def get_model(model_id: str) -> registry.ModelEntry:
    entry = registry.get_by_id(model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"unknown model: {model_id}")
    return entry


@router.post("/{model_id:path}/load")
async def load_model(model_id: str) -> dict[str, str]:
    """Eagerly load a model into memory. Blocks until ready."""
    entry = registry.get_by_id(model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"unknown model: {model_id}")
    try:
        loader.get_model(model_id)
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail=(
                "transformer-lens is not installed in this environment. "
                "Install with: pip install -e '.[ml]'"
            ),
        ) from e
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"status": "loaded", "model": model_id}


@router.delete("/{model_id:path}")
async def unload_model(model_id: str) -> dict[str, str | bool]:
    """Drop a model from memory."""
    unloaded = loader.unload(model_id)
    return {"status": "unloaded" if unloaded else "not_loaded", "model": model_id, "unloaded": unloaded}
