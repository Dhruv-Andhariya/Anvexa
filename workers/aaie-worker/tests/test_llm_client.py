"""GeminiClient error mapping, with a fake SDK client: no network, no key needed."""

from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors as genai_errors

from app.schemas.dsa_evaluation import GeminiDsaWire
from app.services import llm_client as mod
from app.services.llm_client import (
    GeminiClient,
    LLMBlockedError,
    LLMInvalidOutputError,
    LLMNotConfiguredError,
    LLMTimeoutError,
    LLMUnavailableError,
)


@pytest.fixture(autouse=True)
def _real_generate_json(monkeypatch):
    # conftest blocks GeminiClient.generate_json; these tests exercise it against a fake SDK client instead
    monkeypatch.setattr(mod.GeminiClient, "generate_json", _ORIGINAL)


_ORIGINAL = mod.GeminiClient.generate_json


class _Models:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "config": config})
        if self.error is not None:
            raise self.error
        return self.result


def client(result=None, error=None) -> tuple[GeminiClient, _Models]:
    models = _Models(result, error)
    return GeminiClient(api_key="k" * 20, model="configured-model", timeout_seconds=5, client=SimpleNamespace(models=models)), models


def call(c: GeminiClient) -> str:
    return c.generate_json(system="s", prompt="p", schema=GeminiDsaWire, temperature=0.0)


def test_returns_the_json_text_and_sends_structured_output_settings():
    c, models = client(SimpleNamespace(text='{"approach": "CORRECT"}', candidates=[SimpleNamespace(finish_reason="STOP")]))
    assert call(c) == '{"approach": "CORRECT"}'
    config = models.calls[0]["config"]
    assert models.calls[0]["model"] == "configured-model"
    assert config.response_mime_type == "application/json" and config.temperature == 0.0
    assert config.automatic_function_calling.disable is True


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (httpx.ReadTimeout("slow"), LLMTimeoutError),
        (httpx.ConnectError("down"), LLMUnavailableError),
        (genai_errors.ServerError(503, {"error": {"message": "overloaded"}}), LLMUnavailableError),
        (genai_errors.ClientError(429, {"error": {"message": "quota"}}), LLMUnavailableError),
        (genai_errors.ClientError(403, {"error": {"message": "bad key"}}), LLMNotConfiguredError),
        (genai_errors.ServerError(504, {"error": {"message": "deadline"}}), LLMTimeoutError),
        (ValueError("anything else"), LLMUnavailableError),
    ],
)
def test_sdk_failures_become_safe_typed_errors(error, expected):
    c, _ = client(error=error)
    with pytest.raises(expected) as exc:
        call(c)
    assert "quota" not in str(exc.value) and "bad key" not in str(exc.value)


def test_blocked_and_empty_replies():
    blocked, _ = client(SimpleNamespace(text="{}", candidates=[SimpleNamespace(finish_reason="SAFETY")]))
    with pytest.raises(LLMBlockedError):
        call(blocked)
    empty, _ = client(SimpleNamespace(text="  ", candidates=[]))
    with pytest.raises(LLMInvalidOutputError):
        call(empty)


def test_not_configured_without_key_or_model():
    with pytest.raises(LLMNotConfiguredError):
        GeminiClient(api_key="", model="m", timeout_seconds=5, client=object())
    with pytest.raises(LLMNotConfiguredError):
        GeminiClient(api_key="k", model="", timeout_seconds=5, client=object())
