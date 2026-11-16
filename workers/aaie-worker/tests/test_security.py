from conftest import SECRET
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.security import require_worker_secret


def _protected_app(settings) -> TestClient:
    """A test-only app with one protected route: Phase 1 itself has no protected routes yet."""
    app = FastAPI()
    app.state.settings = settings

    @app.get("/protected", dependencies=[Depends(require_worker_secret)])
    def protected() -> dict:
        return {"ok": True}

    return TestClient(app)


def test_no_secret_configured_means_no_check(open_settings):
    assert _protected_app(open_settings).get("/protected").status_code == 200


def test_secret_configured_requires_the_header(secured_settings):
    client = _protected_app(secured_settings)
    assert client.get("/protected").status_code == 401
    assert client.get("/protected", headers={"x-worker-secret": "wrong-secret-000000"}).status_code == 401
    assert client.get("/protected", headers={"x-worker-secret": SECRET}).status_code == 200


def test_rejection_never_echoes_the_secret(secured_settings):
    res = _protected_app(secured_settings).get("/protected", headers={"x-worker-secret": "wrong-secret-000000"})
    assert SECRET not in res.text and "wrong-secret" not in res.text
