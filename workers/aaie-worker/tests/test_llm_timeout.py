"""AAIE Gemini time-out: 60 s by default, configurable, really passed to the SDK, and a time-out is RE_EVALUATE /
AI_TIMEOUT - never a candidate failure, never marks or progression. No network: fake SDK client / dummy key only."""

from types import SimpleNamespace

import httpx
import pytest
from fakes import FakeLLM, request
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors

from app.config import DEFAULT_LLM_TIMEOUT_SECONDS, get_settings
from app.main import create_app
from app.schemas.dsa_evaluation import GeminiDsaWire
from app.services import llm_client as mod
from app.services.llm_client import GeminiClient, LLMTimeoutError

DUMMY_KEY = "offline-dummy-key-0123456789"  # never a real key; nothing is sent anywhere
URL = "/v1/dsa/evaluate"
_ORIGINAL = mod.GeminiClient.generate_json


@pytest.fixture
def real_generate_json(monkeypatch):
    # conftest blocks GeminiClient.generate_json; these tests run it against a fake SDK client (no network)
    monkeypatch.setattr(mod.GeminiClient, "generate_json", _ORIGINAL)


class _Models:
    def __init__(self, error=None):
        self.error, self.configs = error, []

    def generate_content(self, *, model, contents, config):
        self.configs.append(config)
        raise self.error


# ------------------------------------------------------------------------------------------------ configuration


def test_default_timeout_is_60_seconds():
    assert DEFAULT_LLM_TIMEOUT_SECONDS == 60.0
    assert get_settings({}).llm_timeout_seconds == 60.0


@pytest.mark.parametrize(("value", "expected"), [("30", 30.0), ("45", 45.0), ("1", 1.0), ("300", 300.0), (" 12.5 ", 12.5)])
def test_environment_override(value, expected):
    assert get_settings({"AAIE_LLM_TIMEOUT_SECONDS": value}).llm_timeout_seconds == expected


def test_the_app_builds_the_gemini_client_with_the_configured_timeout():
    s = get_settings({"GEMINI_API_KEY": DUMMY_KEY, "AAIE_LLM_MODEL": "test-model", "AAIE_LLM_TIMEOUT_SECONDS": "30"})
    llm = create_app(s).state.llm_client
    assert isinstance(llm, GeminiClient) and llm._timeout_ms == 30_000
    default = create_app(get_settings({"GEMINI_API_KEY": DUMMY_KEY, "AAIE_LLM_MODEL": "test-model"})).state.llm_client
    assert default._timeout_ms == 60_000


# ------------------------------------------------------------------------------------------------ the SDK receives it


def test_the_sdk_client_is_created_with_the_timeout_and_one_attempt():
    c = GeminiClient(api_key=DUMMY_KEY, model="test-model", timeout_seconds=30)  # real SDK client, no request made
    options = c._client._api_client._http_options
    assert options.timeout == 30_000
    assert options.retry_options is not None and options.retry_options.attempts == 1


def test_every_request_carries_the_timeout_and_one_attempt(real_generate_json):
    models = _Models(error=httpx.ReadTimeout("slow"))
    c = GeminiClient(api_key=DUMMY_KEY, model="test-model", timeout_seconds=30, client=SimpleNamespace(models=models))
    with pytest.raises(LLMTimeoutError):
        c.generate_json(system="s", prompt="p", schema=GeminiDsaWire, temperature=0.0)
    http = models.configs[0].http_options
    assert http.timeout == 30_000 and http.retry_options.attempts == 1


def test_an_overridden_timeout_reaches_the_request(real_generate_json):
    models = _Models(error=httpx.ReadTimeout("slow"))
    c = GeminiClient(api_key=DUMMY_KEY, model="test-model", timeout_seconds=12.5, client=SimpleNamespace(models=models))
    with pytest.raises(LLMTimeoutError):
        c.generate_json(system="s", prompt="p", schema=GeminiDsaWire, temperature=0.0)
    assert models.configs[0].http_options.timeout == 12_500


# ------------------------------------------------------------------------------------------------ outcome on time-out


@pytest.mark.parametrize(
    "error",
    [httpx.ReadTimeout("slow"), httpx.ConnectTimeout("slow"), genai_errors.ServerError(504, {"error": {"message": "deadline"}})],
    ids=["read-timeout", "connect-timeout", "provider-504"],
)
def test_a_real_client_timeout_is_re_evaluate_ai_timeout_never_fail(open_settings, real_generate_json, error):
    models = _Models(error=error)
    llm = GeminiClient(api_key=DUMMY_KEY, model="test-model", timeout_seconds=30, client=SimpleNamespace(models=models))
    res = TestClient(create_app(open_settings, llm_client=llm)).post(URL, json=request())
    body = res.json()
    assert res.status_code == 200 and len(models.configs) == 1  # one attempt, no retry
    assert body["status"] == "RE_EVALUATE" and body["reEvaluate"]["code"] == "AI_TIMEOUT"
    assert body["logicBand"] is None and body["bandSource"] is None and body["approach"] is None
    assert body["defects"] == [] and body["reasoning"] is None
    # no candidate marks, pass / fail or progression, and no FAIL anywhere
    assert not {"marks", "score", "passed", "outcome", "decision", "progression"} & set(body)
    assert "FAIL" not in res.text.replace("AI_TIMEOUT", "")
    assert body["versions"]["model"] == "test-model"


def test_a_timeout_never_lowers_a_band_for_any_submission(open_settings):
    for req in (request(), request(passed=0), request(verdict="passed", passed=4, total=4)):
        body = TestClient(create_app(open_settings, llm_client=FakeLLM(error=LLMTimeoutError()))).post(URL, json=req).json()
        if body["bandSource"] == "EXECUTION":  # a complete passing Submit never calls the AI (H7): unaffected
            assert body["logicBand"] == 100
        else:
            assert (body["status"], body["logicBand"], body["reEvaluate"]["code"]) == ("RE_EVALUATE", None, "AI_TIMEOUT")
