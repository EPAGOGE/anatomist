"""Frontier proxy — a server-side relay so the web Chat page can reach
frontier providers whose CORS blocks direct browser calls (e.g. NVIDIA NIM).
Anthropic / OpenAI / Gemini and local runners (LM Studio, Ollama) are called
directly from the browser; only CORS-blocked hosts route through here.

Local-only helper, isolated from the model registry and probe pipeline. The
user's key is passed per request and never stored or logged. SSRF-guarded:
only https:// or http://localhost targets are allowed.
"""

from __future__ import annotations

import logging
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

_TIMEOUT = 120.0
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class FrontierMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class FrontierChatRequest(BaseModel):
    kind: Literal["anthropic", "openai", "gemini"]
    base_url: str
    api_key: str = ""
    model: str
    messages: list[FrontierMessage]
    system: str | None = None
    max_tokens: int = 1024


class FrontierModelsRequest(BaseModel):
    base_url: str
    api_key: str = ""


def _guard_url(base_url: str) -> None:
    """Only allow https, or http to a loopback host (local runners). Blocks
    the proxy from being pointed at arbitrary internal http services."""
    parsed = urlparse(base_url)
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and parsed.hostname in _LOCAL_HOSTS:
        return
    raise HTTPException(
        status_code=400,
        detail="base_url must be https:// or http://localhost",
    )


def _upstream_detail(resp: httpx.Response) -> str:
    try:
        body: Any = resp.json()
    except ValueError:
        return f"{resp.status_code} {resp.reason_phrase}"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            return str(err["message"])
        if isinstance(err, str):
            return err
        if isinstance(body.get("message"), str):
            return str(body["message"])
    return f"{resp.status_code} {resp.reason_phrase}"


def _text_from_anthropic(data: Any) -> str:
    blocks = data.get("content") if isinstance(data, dict) else None
    if not isinstance(blocks, list):
        return ""
    return "".join(
        str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("type") == "text"
    ).strip()


def _text_from_openai(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message["content"].strip()
    return ""


def _text_from_gemini(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    candidates = data.get("candidates")
    if isinstance(candidates, list) and candidates:
        content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
        parts = content.get("parts") if isinstance(content, dict) else None
        if isinstance(parts, list):
            return "".join(
                str(p.get("text", "")) for p in parts if isinstance(p, dict)
            ).strip()
    return ""


@router.post("/chat")
async def frontier_chat(req: FrontierChatRequest) -> dict[str, Any]:
    """Relay one chat turn to the user's provider and return the reply text."""
    base = req.base_url.rstrip("/")
    _guard_url(base)
    system = req.system or "You are a helpful assistant."
    messages = [m.model_dump() for m in req.messages]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            if req.kind == "anthropic":
                resp = await client.post(
                    f"{base}/v1/messages",
                    headers={
                        "content-type": "application/json",
                        "x-api-key": req.api_key,
                        "anthropic-version": "2023-06-01",
                    },
                    json={
                        "model": req.model,
                        "max_tokens": req.max_tokens,
                        "system": system,
                        "messages": messages,
                    },
                )
            elif req.kind == "gemini":
                resp = await client.post(
                    f"{base}/models/{req.model}:generateContent",
                    params={"key": req.api_key},
                    headers={"content-type": "application/json"},
                    json={
                        "systemInstruction": {"parts": [{"text": system}]},
                        "contents": [
                            {
                                "role": "model" if m["role"] == "assistant" else "user",
                                "parts": [{"text": m["content"]}],
                            }
                            for m in messages
                        ],
                        "generationConfig": {"maxOutputTokens": req.max_tokens},
                    },
                )
            else:  # openai-compatible
                resp = await client.post(
                    f"{base}/chat/completions",
                    headers={
                        "content-type": "application/json",
                        "authorization": f"Bearer {req.api_key or 'local'}",
                    },
                    json={
                        "model": req.model,
                        "max_tokens": req.max_tokens,
                        "messages": [{"role": "system", "content": system}, *messages],
                    },
                )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"could not reach provider: {exc}") from exc

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_upstream_detail(resp))

    data = resp.json()
    if req.kind == "anthropic":
        text = _text_from_anthropic(data)
    elif req.kind == "gemini":
        text = _text_from_gemini(data)
    else:
        text = _text_from_openai(data)
    return {"text": text, "model": req.model}


@router.post("/models")
async def frontier_models(req: FrontierModelsRequest) -> dict[str, list[str]]:
    """List an OpenAI-compatible provider's models (`GET /models`) server-side,
    so CORS-blocked hosts can be auto-discovered by the Chat panel."""
    base = req.base_url.rstrip("/")
    _guard_url(base)
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(
                f"{base}/models",
                headers={"authorization": f"Bearer {req.api_key or 'local'}"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"could not reach provider: {exc}") from exc

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_upstream_detail(resp))

    data: Any = resp.json()
    ids: list[str] = []
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        ids = [m["id"] for m in data["data"] if isinstance(m, dict) and isinstance(m.get("id"), str)]
    return {"models": ids}
