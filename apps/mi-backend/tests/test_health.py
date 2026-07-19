from fastapi.testclient import TestClient


def test_health_live(client: TestClient) -> None:
    res = client.get("/health/live")
    assert res.status_code == 200
