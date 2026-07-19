"""The frontier proxy relays chat turns to a user's provider server-side (for
CORS-blocked hosts). These tests are hermetic — no external network: they
exercise the SSRF guard, body validation, and the unreachable-upstream path
against a closed loopback port.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def _body(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "kind": "openai",
        "base_url": "https://api.example.com/v1",
        "api_key": "k",
        "model": "m",
        "messages": [{"role": "user", "content": "hi"}],
    }
    base.update(over)
    return base


def test_rejects_non_local_http(client: TestClient) -> None:
    """http:// to a non-loopback host is blocked (SSRF guard)."""
    r = client.post("/frontier/chat", json=_body(base_url="http://evil.internal/v1"))
    assert r.status_code == 400
    assert "https" in r.json()["detail"]


def test_validates_body(client: TestClient) -> None:
    """Malformed request (missing required fields) is a 422, never a 500."""
    r = client.post("/frontier/chat", json={"kind": "openai"})
    assert r.status_code == 422


def test_allows_localhost_http_but_502s_when_unreachable(client: TestClient) -> None:
    """A loopback http target passes the guard; an unreachable one surfaces as
    a clean 502 rather than a crash. Uses a closed high port — no network."""
    r = client.post(
        "/frontier/chat",
        json=_body(kind="openai", base_url="http://127.0.0.1:59999/v1"),
    )
    assert r.status_code == 502
    assert "could not reach provider" in r.json()["detail"]


def test_models_guard_rejects_non_local_http(client: TestClient) -> None:
    """The discovery endpoint applies the same SSRF guard as chat."""
    r = client.post("/frontier/models", json={"base_url": "http://evil.internal/v1"})
    assert r.status_code == 400


def test_models_unreachable_is_502(client: TestClient) -> None:
    r = client.post("/frontier/models", json={"base_url": "http://127.0.0.1:59999/v1"})
    assert r.status_code == 502
