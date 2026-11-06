"""Real Gemini call. Opt-in only, because it uses free-tier quota:

    RUN_LLM_INTEGRATION=1 uv run pytest -m integration

Needs LLM_PROVIDER, LLM_MODEL and GEMINI_API_KEY (from the root .env or the environment)."""
import os

import pytest
from fastapi.testclient import TestClient

from ai_worker.config import get_settings, load_env
from ai_worker.main import app
from ai_worker.schemas import JdContent

load_env()
_settings = get_settings()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("RUN_LLM_INTEGRATION") != "1",
        reason="set RUN_LLM_INTEGRATION=1 to call the real LLM provider",
    ),
    pytest.mark.skipif(
        not (_settings.llm_provider and _settings.llm_model and _settings.gemini_api_key),
        reason="LLM_PROVIDER / LLM_MODEL / GEMINI_API_KEY not configured",
    ),
]


def test_real_generation_follows_the_form():
    form = {
        "title": "Junior Backend Developer",
        "experienceMin": 0,
        "experienceMax": 2,
        "mustHaveSkills": ["Node.js", "PostgreSQL", "REST APIs"],
        "niceToHaveSkills": ["Docker"],
        "locations": ["Ahmedabad"],
        "workMode": "HYBRID",
        "employmentType": "FULL_TIME",
    }
    res = TestClient(app).post("/v1/jd/generate", json=form)
    assert res.status_code == 200, res.text
    jd = JdContent.model_validate(res.json())
    assert jd.title == "Junior Backend Developer"
    required = " ".join(jd.requirements).lower()
    for skill in ["node.js", "postgresql", "rest"]:
        assert skill in required
    assert "docker" not in required  # preferred skill must not be promoted to required
    assert res.headers["X-Prompt-Version"] == "jd_generate.v4"
