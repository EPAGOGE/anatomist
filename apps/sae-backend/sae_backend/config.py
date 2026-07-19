"""Settings — mirrors mi_backend's conventions with the SAE_ prefix."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="SAE_",
        case_sensitive=False,
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8766
    reload: bool = True
    log_level: str = "INFO"

    # Read unprefixed to match upstream conventions.
    hf_token: str | None = Field(default=None, validation_alias="HF_TOKEN")
    neuronpedia_api_key: str | None = Field(default=None, validation_alias="NEURONPEDIA_API_KEY")

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
