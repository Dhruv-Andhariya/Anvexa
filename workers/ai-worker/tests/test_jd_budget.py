"""One JD generation has a total time budget (output retry + provider retries + fallback models),
so the worker always answers before the API stops waiting for it."""
import time

import pytest
from fakes import VALID_JD, FakeProvider
from test_gemini_provider import SECRET, _api_error, _Client, _response, _SequenceModels

from ai_worker import config
from ai_worker.jd import generator
from ai_worker.llm_gateway import LLMTimeoutError, PromptSpec, load_prompt
from ai_worker.llm_gateway.gemini import GeminiProvider
from ai_worker.schemas import JdContent, JobForm

FORM = JobForm(
    title="Python Developer",
    experienceMin=1,
    experienceMax=3,
    mustHaveSkills=["Python", "FastAPI", "SQL"],
    locations=["Ahmedabad"],
    workMode="HYBRID",
    employmentType="FULL_TIME",
)


def _prompt() -> PromptSpec:
    return load_prompt(config.get_settings().prompts_dir / generator.PROMPT_FILE)


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_budget_defaults_to_80_seconds_and_reads_env(monkeypatch):
    monkeypatch.delenv("JD_GENERATION_BUDGET_SECONDS", raising=False)
    assert config.get_settings().jd_generation_budget_seconds == 80.0
    monkeypatch.setenv("JD_GENERATION_BUDGET_SECONDS", "45")
    assert config.get_settings().jd_generation_budget_seconds == 45.0


def test_generator_passes_the_deadline_to_the_provider(monkeypatch):
    clock = _Clock()
    monkeypatch.setattr(generator.time, "monotonic", clock)
    fake = FakeProvider().queue(VALID_JD)
    generator.generate_jd(FORM, fake, _prompt(), budget_seconds=80)
    assert fake.calls[0]["deadline"] == 1080.0


def test_no_output_retry_once_the_budget_is_spent(monkeypatch):
    clock = _Clock()
    monkeypatch.setattr(generator.time, "monotonic", clock)

    class Slow(FakeProvider):
        def generate_json(self, **kwargs):
            clock.now += 81  # the first (invalid) answer used up the whole budget
            return super().generate_json(**kwargs)

    fake = Slow().queue("not json", VALID_JD)
    with pytest.raises(LLMTimeoutError):
        generator.generate_jd(FORM, fake, _prompt(), budget_seconds=80)
    assert len(fake.calls) == 1


def _gemini(failures: dict, fallbacks=("lite-a", "lite-b"), timeout=60.0, retries=1):
    client = _Client(None)
    client.models = _SequenceModels(failures, _response('{"a": 1}'))
    provider = GeminiProvider(
        api_key=SECRET,
        model="primary",
        fallback_models=fallbacks,
        timeout_seconds=timeout,
        transient_retries=retries,
        client=client,
    )
    return provider, client


def _call(provider: GeminiProvider, deadline: float | None):
    return provider.generate_json(
        system="sys", prompt="p", schema=JdContent, temperature=0.6, deadline=deadline
    )


def test_gemini_does_not_call_the_model_after_the_deadline():
    provider, client = _gemini({})
    with pytest.raises(LLMTimeoutError):
        _call(provider, time.monotonic() - 1)
    assert client.models.calls == []


def test_gemini_stops_falling_back_once_the_budget_is_spent(monkeypatch):
    from ai_worker.llm_gateway import gemini

    clock = _Clock()
    monkeypatch.setattr(gemini.time, "monotonic", clock)
    overloaded = _api_error(503, "UNAVAILABLE")

    class SlowModels(_SequenceModels):
        def generate_content(self, **kwargs):
            clock.now += 50
            return super().generate_content(**kwargs)

    provider, client = _gemini({"primary": overloaded, "lite-a": overloaded})
    client.models = SlowModels({"primary": overloaded, "lite-a": overloaded}, _response("{}"))
    with pytest.raises(LLMTimeoutError):
        _call(provider, clock.now + 80)
    assert client.models.calls == ["primary", "lite-a"]  # lite-b is never tried


def test_gemini_bounds_each_request_by_the_remaining_time():
    provider, _ = _gemini({}, timeout=60, retries=1)
    roomy = provider._bounded_http_options(200)
    assert roomy.timeout == 60_000 and roomy.retry_options.attempts == 2
    tight = provider._bounded_http_options(80)  # a second 60s attempt would not fit
    assert tight.timeout == 60_000 and tight.retry_options.attempts == 1
    last = provider._bounded_http_options(12.5)
    assert last.timeout == 12_500 and last.retry_options.attempts == 1

