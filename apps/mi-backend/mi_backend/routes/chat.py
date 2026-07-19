"""Chat endpoint — WebSocket — Subsystem 4.

Streaming chat with the loaded model. The frame contract is symmetric with
how the frontend's useChatSocket hook consumes it (apps/web/src/components/
workbench/ModelChat.tsx).

Frame contract (client → server):
    {prompt: str, model_id: str}

Frame contract (server → client):
    {event: "start", model: str}
    {event: "token", text: str}    (repeated as generation proceeds)
    {event: "end"}
    {event: "error", message: str} (terminal)

Real path (V2 — activates when transformer-lens is installed):
  - Load the model via the same lazy loader the probe routes use
  - Encode the prompt with the bridge's tokenizer
  - Generate one token at a time, decoding + sending each as it lands
  - Stop on EOS or max_new_tokens

Stub path (V1 — when ML deps missing): echo the prompt with a hint that
real generation needs the ML install. Lets the whole chat UI be testable
end-to-end before any model is loaded.

The activation cache from the final forward pass would be captured here
in a V2.1 follow-on (so the toolchest can probe the response immediately).
Wiring point: after the loop, call bridge.run_with_cache(full_token_seq)
once and stash the cache against a session id the toolchest can reach.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

if TYPE_CHECKING:
    from transformer_lens.model_bridge import TransformerBridge  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)
router = APIRouter()

# Generation defaults — tunable per request later via the payload.
MAX_NEW_TOKENS = 256
TEMPERATURE = 0.8
TOP_K = 40


@router.websocket("/ws")
async def chat_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            payload = await websocket.receive_json()
            prompt = str(payload.get("prompt", ""))
            model_id = str(payload.get("model_id", "gemma-2-2b-it"))

            await websocket.send_json({"event": "start", "model": model_id})

            try:
                await _real_generate(websocket, model_id, prompt)
            except (ImportError, RuntimeError) as e:
                logger.info("chat: degrading to stub (%s)", e)
                await _stub_generate(websocket, model_id, prompt, reason=str(e))

            await websocket.send_json({"event": "end"})
    except WebSocketDisconnect:
        logger.info("chat ws disconnected")
    except Exception as e:
        logger.exception("chat ws unexpected error")
        with contextlib.suppress(Exception):
            await websocket.send_json({"event": "error", "message": str(e)})


async def _real_generate(websocket: WebSocket, model_id: str, prompt: str) -> None:
    """Stream tokens from bridge.generate-style loop.

    Raises ImportError if transformer-lens is missing; RuntimeError on
    load failure. The chat_ws caller catches these and falls back to the
    stub path so the frontend always gets some response.
    """
    from mi_backend.models import loader

    bridge: TransformerBridge = loader.get_model(model_id)
    # Heavy imports happen here so the scaffold imports cleanly without them.
    import torch

    tokens = bridge.to_tokens(prompt)
    # Track only what we'll need to detect EOS — bridge exposes the tokenizer.
    eos_id: int | None = None
    try:
        eos_id = bridge.tokenizer.eos_token_id
    except Exception:
        eos_id = None

    for _ in range(MAX_NEW_TOKENS):
        with torch.no_grad():
            # forward gives logits shaped (batch, seq, vocab); we want the last token's.
            logits = bridge(tokens)[0, -1]

        next_token_id = _sample_token(logits, temperature=TEMPERATURE, top_k=TOP_K)
        # Append to context for the next step.
        tokens = torch.cat(
            [tokens, torch.tensor([[next_token_id]], device=tokens.device, dtype=tokens.dtype)],
            dim=-1,
        )

        # Decode just this token and stream it.
        token_text = bridge.tokenizer.decode([next_token_id], skip_special_tokens=False)
        await websocket.send_json({"event": "token", "text": token_text})

        if eos_id is not None and next_token_id == eos_id:
            break

        # Cooperate with the event loop so other connections aren't blocked
        # while a long generation runs on this socket.
        await asyncio.sleep(0)


def _sample_token(logits: Any, *, temperature: float, top_k: int) -> int:
    """Top-k sampling. Greedy when temperature is 0; otherwise softmax.

    Kept here (not as a separate util) so the chat path is self-contained
    — easier to read and tune as we land more generation features.
    """
    import torch

    if temperature <= 0:
        return int(torch.argmax(logits).item())

    # Top-k filter: zero out everything outside the top k logits, softmax over the rest.
    k = min(top_k, logits.shape[-1])
    top_values, top_indices = torch.topk(logits, k=k)
    probs = torch.softmax(top_values / temperature, dim=-1)
    choice_idx = int(torch.multinomial(probs, num_samples=1).item())
    return int(top_indices[choice_idx].item())


async def _stub_generate(
    websocket: WebSocket,
    model_id: str,
    prompt: str,
    *,
    reason: str,
) -> None:
    """Fallback when real generation isn't available.

    Echoes a short canned response so the frontend can verify wiring +
    surface the reason (typically: transformer-lens not installed).
    """
    chunks = [
        f"[stub] you asked {model_id!r} about: ",
        f"{prompt[:120]!r}",
        ". Real generation activates the moment you `pip install -e '.[ml]'` ",
        "and set HF_TOKEN in apps/mi-backend/.env.",
        f" (degrade reason: {reason[:140]})",
    ]
    for chunk in chunks:
        await websocket.send_json({"event": "token", "text": chunk})
        await asyncio.sleep(0.05)
