import pytest
from fakes import FakeProvider

from ai_worker.main import app, get_llm_provider, get_speech_provider


def _no_real_llm():
    raise AssertionError("Unit tests must not call the real LLM provider; use the fake_llm fixture")


def _no_real_speech():
    raise AssertionError("Unit tests must not call the real speech provider; use the fake_speech fixture")


@pytest.fixture(autouse=True)
def _block_real_llm(request):
    if request.node.get_closest_marker("integration"):
        yield
        return
    app.dependency_overrides[get_llm_provider] = lambda: _no_real_llm
    app.dependency_overrides[get_speech_provider] = lambda: _no_real_speech
    yield
    app.dependency_overrides.pop(get_llm_provider, None)
    app.dependency_overrides.pop(get_speech_provider, None)


@pytest.fixture
def fake_llm():
    fake = FakeProvider()
    app.dependency_overrides[get_llm_provider] = lambda: (lambda: fake)
    return fake
