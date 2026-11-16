import pytest

from app.config import Settings

SECRET = "test-secret-0123456789"


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch):
    """Tests never depend on the developer's .env: every AAIE / Gemini variable is cleared."""
    for name in (
        "AAIE_WORKER_HOST",
        "AAIE_WORKER_PORT",
        "AAIE_WORKER_SECRET",
        "AAIE_WORKER_LOG_LEVEL",
        "GEMINI_API_KEY",
        "AAIE_LLM_MODEL",
        "AAIE_LLM_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def _block_real_gemini(monkeypatch):
    """Unit tests must never call the real Gemini API (no key needed, no network)."""

    def _no_real_call(*_args, **_kwargs):
        raise AssertionError("Unit tests must not call the real Gemini API; use the FakeLLM from tests/fakes.py")

    monkeypatch.setattr("app.services.llm_client.GeminiClient.generate_json", _no_real_call)


@pytest.fixture
def open_settings() -> Settings:
    return Settings(host="127.0.0.1", port=8020, worker_secret="", log_level="INFO")


@pytest.fixture
def secured_settings() -> Settings:
    return Settings(host="127.0.0.1", port=8020, worker_secret=SECRET, log_level="INFO")
