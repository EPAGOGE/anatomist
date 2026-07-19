"""Settings via pydantic-settings — env vars + .env file.

Env vars use the MI_ prefix (e.g. MI_PORT, MI_DEFAULT_MODEL) except for
upstream-standard names like HF_TOKEN and RUNPOD_API_KEY, which we read
unprefixed so they match the conventions of the libraries that consume them.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="MI_",
        case_sensitive=False,
        extra="ignore",
    )

    # Server
    host: str = "127.0.0.1"
    port: int = 8765
    reload: bool = True
    log_level: str = "INFO"

    # Model loading
    default_model: str = "gemma-2-2b-it"
    model_cache: Path = Path("./hf_cache")
    device: Literal["auto", "cpu", "mps", "cuda"] = "auto"
    # Load precision. float16 halves memory vs float32 — essential on Apple
    # MPS (a ~20GB GPU budget OOMs on fp32 for a 2B model in compatibility
    # mode). float32 only when you have the RAM and want exact numerics.
    dtype: Literal["float16", "bfloat16", "float32"] = "float16"

    # Auth — read without MI_ prefix so they match upstream conventions
    hf_token: str | None = Field(default=None, validation_alias="HF_TOKEN")
    runpod_api_key: str | None = Field(default=None, validation_alias="RUNPOD_API_KEY")

    # CORS — apps/web in dev runs at :5173 (vite default)
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()


def resolve_device(setting: str) -> str:
    """Pick the best available torch device given the user's preference."""
    if setting != "auto":
        return setting
    try:
        import torch
    except ImportError:
        return "cpu"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"
