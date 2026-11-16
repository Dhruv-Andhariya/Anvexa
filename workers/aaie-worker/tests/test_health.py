from conftest import SECRET
from fastapi.testclient import TestClient

from app.main import create_app


def test_health_is_ok_and_reports_no_ai(open_settings):
    res = TestClient(create_app(open_settings)).get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "aaie-worker", "version": "0.1.0", "aiEnabled": False}


def test_health_is_public_even_when_a_secret_is_set(secured_settings):
    res = TestClient(create_app(secured_settings)).get("/health")  # no x-worker-secret header
    assert res.status_code == 200
    assert SECRET not in res.text


def test_health_works_without_any_ai_key(open_settings, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert TestClient(create_app(open_settings)).get("/health").status_code == 200


def test_only_health_and_the_dsa_endpoint_are_exposed(open_settings):
    paths = set(create_app(open_settings).openapi()["paths"])
    assert paths == {"/health", "/v1/dsa/evaluate"}


def test_health_reports_ai_enabled_only_when_configured(open_settings):
    from fakes import FakeLLM

    assert TestClient(create_app(open_settings, llm_client=FakeLLM())).get("/health").json()["aiEnabled"] is True
    assert TestClient(create_app(open_settings, llm_client=None)).get("/health").json()["aiEnabled"] is False


def test_the_module_level_app_starts_and_answers():
    from app.config import Settings
    from app.main import app

    assert isinstance(app.state.settings, Settings)
    assert TestClient(app).get("/health").json()["status"] == "ok"
