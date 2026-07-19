"""Efficient tensor serialization for WebSocket transport.

Wire format: a small JSON header announcing shape+dtype+name, followed by
a binary frame containing the raw tensor bytes. Browser-side: decode the
binary into a typed array (Float32Array, etc.) of the announced shape.

Why this over msgpack-numpy or pickle:
- Portable: any client can decode (no Python-specific format)
- Efficient: zero-copy on the send side, contiguous memory on receive
- Browser-friendly: TypedArrays are native; one read = one tensor

Alternative if header overhead matters: pack shape+dtype into a fixed-size
binary prefix on the data frame itself (saves one round-trip but reduces
debuggability).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import numpy as np
    from fastapi import WebSocket


async def send_tensor(
    websocket: WebSocket,
    tensor: np.ndarray,
    *,
    name: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Send a numpy tensor over a WebSocket as header + binary frame.

    The tensor is sent in its native dtype. The receiving side reads the
    JSON header first (to learn shape + dtype + name), then reads the
    binary frame and reshapes into a typed array.
    """
    header = {
        "event": "tensor",
        "name": name,
        "shape": list(tensor.shape),
        "dtype": str(tensor.dtype),
        "metadata": metadata or {},
    }
    await websocket.send_json(header)
    # Ensure contiguous memory layout before sending bytes.
    contiguous = tensor if tensor.flags["C_CONTIGUOUS"] else tensor.copy()
    await websocket.send_bytes(contiguous.tobytes())


async def send_torch_tensor(
    websocket: WebSocket,
    tensor: Any,
    *,
    name: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Convenience wrapper: detach + cpu + numpy, then send.

    Lazy-imports torch so the module is importable without it.
    """
    arr = tensor.detach().cpu().numpy()
    await send_tensor(websocket, arr, name=name, metadata=metadata)
