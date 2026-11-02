from fastapi.testclient import TestClient

from ai_worker.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"
