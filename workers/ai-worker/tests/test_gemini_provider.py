"""GeminiProvider error mapping and request shape, using a fake SDK client (no network)."""
import httpx
import pytest
from google.genai import errors as genai_errors
from google.genai import types

from ai_worker.llm_gateway import (
    Attachment,
    LLMAuthError,
    LLMBlockedError,
    LLMError,
    LLMInvalidOutputError,
    LLMNotConfiguredError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUnavailableError,
)
from ai_worker.llm_gateway.gemini import GeminiProvider
from ai_worker.schemas import JdContent

SECRET = "AIza-test-secret-should-never-leak"


class _Models:
    def __init__(self, outcome):
        self.outcome = outcome
        self.kwargs = None

    def generate_content(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class _Client:
    def __init__(self, outcome):
        self.models = _Models(outcome)


def _provider(outcome) -> tuple[GeminiProvider, _Client]:
    client = _Client(outcome)
    return GeminiProvider(api_key=SECRET, model="gemini-test", client=client), client


def _call(provider: GeminiProvider):
    return provider.generate_json(system="sys", prompt="p", schema=JdContent, temperature=0.6)


def _response(text: str | None, finish: str = "STOP", block: str | None = None):
    parts = [types.Part(text=text)] if text is not None else []
    return types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                content=types.Content(role="model", parts=parts),
                finish_reason=types.FinishReason(finish),
            )
        ],
        prompt_feedback=types.GenerateContentResponsePromptFeedback(
            block_reason=types.BlockedReason(block)
        )
        if block
        else None,
    )


def _api_error(code: int, status: str, message: str = "boom", details=None):
    body = {"error": {"code": code, "status": status, "message": message, "details": details or []}}
    cls = genai_errors.ClientError if code < 500 else genai_errors.ServerError
    return cls(code, body)


def test_requests_structured_json_with_schema():
    provider, client = _provider(_response('{"a": 1}'))
    result = _call(provider)
    assert result.text == '{"a": 1}' and result.model == "gemini-test"
    kwargs = client.models.kwargs
    assert kwargs["model"] == "gemini-test"
    config = kwargs["config"]
    assert config.response_mime_type == "application/json"
    assert config.response_schema is JdContent
    assert config.system_instruction == "sys"
    assert config.temperature == 0.6



def test_attachments_are_sent_before_the_prompt():
    provider, client = _provider(_response('{"a": 1}'))
    provider.generate_json(
        system="sys", prompt="p", schema=JdContent, temperature=0,
        attachments=[Attachment(data=b"%PDF-1.4", mime_type="application/pdf")],
    )
    file_part, text = client.models.kwargs["contents"]
    assert file_part.inline_data.data == b"%PDF-1.4"
    assert file_part.inline_data.mime_type == "application/pdf"
    assert text == "p"


def test_without_attachments_the_prompt_is_sent_as_plain_text():
    provider, client = _provider(_response('{"a": 1}'))
    _call(provider)
    assert client.models.kwargs["contents"] == "p"

@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (_api_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded"), LLMRateLimitError),
        (_api_error(400, "INVALID_ARGUMENT", f"API key not valid: {SECRET}"), LLMAuthError),
        (_api_error(403, "PERMISSION_DENIED"), LLMAuthError),
        (_api_error(404, "NOT_FOUND", "models/x is not found"), LLMNotConfiguredError),
        (_api_error(500, "INTERNAL"), LLMUnavailableError),
        (_api_error(503, "UNAVAILABLE"), LLMUnavailableError),
        (_api_error(504, "DEADLINE_EXCEEDED"), LLMTimeoutError),
        (_api_error(400, "INVALID_ARGUMENT", "bad schema"), LLMError),
        (httpx.ReadTimeout("slow"), LLMTimeoutError),
        (httpx.ConnectError("dns"), LLMUnavailableError),
    ],
)
def test_sdk_errors_are_mapped_and_never_leak(error, expected):
    provider, _ = _provider(error)
    with pytest.raises(expected) as info:
        _call(provider)
    assert type(info.value) is expected
    assert SECRET not in info.value.message
    assert info.value.__cause__ is None  # raw provider error is not chained into tracebacks


def test_rate_limit_reads_retry_delay():
    details = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "30s"}]
    provider, _ = _provider(_api_error(429, "RESOURCE_EXHAUSTED", details=details))
    with pytest.raises(LLMRateLimitError) as info:
        _call(provider)
    assert info.value.retry_after == 31


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (_response(None, block="SAFETY"), LLMBlockedError),
        (_response("{}", finish="SAFETY"), LLMBlockedError),
        (_response('{"title": "trunc', finish="MAX_TOKENS"), LLMInvalidOutputError),
        (_response(""), LLMInvalidOutputError),
        (_response(None), LLMInvalidOutputError),
    ],
)
def test_unusable_responses(response, expected):
    provider, _ = _provider(response)
    with pytest.raises(expected):
        _call(provider)


@pytest.mark.parametrize(("key", "model"), [("", "gemini-test"), (SECRET, "")])
def test_missing_configuration(key, model):
    with pytest.raises(LLMNotConfiguredError):
        GeminiProvider(api_key=key, model=model, client=_Client(None))


class _SequenceModels:
    """Fails with the given outcome per model name; succeeds for models not listed."""

    def __init__(self, failures: dict, success):
        self.failures = failures
        self.success = success
        self.calls: list[str] = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs["model"])
        failure = self.failures.get(kwargs["model"])
        if failure is not None:
            raise failure
        return self.success


def _fallback_provider(failures: dict, fallbacks=("lite-a", "lite-b")):
    client = _Client(None)
    client.models = _SequenceModels(failures, _response('{"a": 1}'))
    provider = GeminiProvider(
        api_key=SECRET, model="primary", fallback_models=fallbacks, client=client
    )
    return provider, client


def test_falls_back_to_next_model_when_primary_overloaded():
    provider, client = _fallback_provider({"primary": _api_error(503, "UNAVAILABLE")})
    result = _call(provider)
    assert result.model == "lite-a"
    assert client.models.calls == ["primary", "lite-a"]


def test_raises_unavailable_when_every_model_overloaded():
    overloaded = _api_error(503, "UNAVAILABLE")
    provider, client = _fallback_provider(
        {"primary": overloaded, "lite-a": overloaded, "lite-b": overloaded}
    )
    with pytest.raises(LLMUnavailableError):
        _call(provider)
    assert client.models.calls == ["primary", "lite-a", "lite-b"]


def test_falls_back_to_next_model_when_primary_out_of_quota():
    provider, client = _fallback_provider(
        {"primary": _api_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded")}
    )
    assert _call(provider).model == "lite-a"
    assert client.models.calls == ["primary", "lite-a"]


def test_last_models_error_is_raised_when_all_fail():
    provider, _ = _fallback_provider(
        {
            "primary": _api_error(503, "UNAVAILABLE"),
            "lite-a": _api_error(503, "UNAVAILABLE"),
            "lite-b": _api_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded"),
        }
    )
    with pytest.raises(LLMRateLimitError):
        _call(provider)


@pytest.mark.parametrize(
    "error",
    [
        _api_error(403, "PERMISSION_DENIED"),
        _api_error(400, "INVALID_ARGUMENT"),
    ],
)
def test_does_not_fall_back_on_non_transient_errors(error):
    provider, client = _fallback_provider({"primary": error})
    with pytest.raises(LLMError):
        _call(provider)
    assert client.models.calls == ["primary"]


def test_fallback_list_skips_blanks_and_primary_duplicate():
    provider, _ = _fallback_provider({}, fallbacks=("", "primary", "lite-a"))
    assert provider.fallback_models == ("lite-a",)


class _ThinkingRefusingModels:
    """Like gemini-3.5-flash-lite: a thinking budget it does not support is a 400 "invalid argument"."""

    def __init__(self):
        self.configs = []

    def generate_content(self, *, model, contents, config):
        self.configs.append(config)
        if config.thinking_config is not None:
            raise _api_error(400, "INVALID_ARGUMENT", "Request contains an invalid argument.")
        return _response('{"title": "x"}')


def test_thinking_budget_is_sent_and_dropped_when_the_model_refuses_it():
    client = _Client(None)
    client.models = _ThinkingRefusingModels()
    provider = GeminiProvider(api_key=SECRET, model="gemini-test", client=client)
    out = provider.generate_json(system="sys", prompt="p", schema=JdContent, temperature=0, thinking_budget=0)
    assert out.text == '{"title": "x"}'
    assert [c.thinking_config is not None for c in client.models.configs] == [True, False]
    assert client.models.configs[0].thinking_config.thinking_budget == 0


def test_no_thinking_setting_by_default():
    provider, client = _provider(_response('{"title": "x"}'))
    _call(provider)
    assert client.models.kwargs["config"].thinking_config is None


def test_other_400s_are_not_retried():
    provider, _client = _provider(_api_error(400, "INVALID_ARGUMENT"))
    with pytest.raises(LLMError):
        provider.generate_json(system="sys", prompt="p", schema=JdContent, temperature=0)
