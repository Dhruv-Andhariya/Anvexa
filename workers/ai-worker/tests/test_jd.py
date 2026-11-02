from fakes import VALID_JD
from fastapi.testclient import TestClient

from ai_worker.main import app

client = TestClient(app)


def test_generate_jd_uses_job_requirements(fake_llm):
    fake_llm.queue(VALID_JD)
    payload = {
        "title": "Python Developer",
        "experienceMin": 1,
        "experienceMax": 3,
        "mustHaveSkills": ["Python", "FastAPI", "SQL"],
        "niceToHaveSkills": ["Docker"],
        "locations": ["Ahmedabad"],
        "workMode": "HYBRID",
        "employmentType": "FULL_TIME",
    }

    response = client.post("/v1/jd/generate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Python Developer"
    assert body["responsibilities"]
    assert body["requirements"]
    assert any("Python" in item for item in body["requirements"])


def test_validate_jd_rejects_empty_responsibilities():
    payload = {
        "title": "Python Developer",
        "summary": "Join our engineering team.",
        "responsibilities": [],
        "requirements": ["Python"],
        "niceToHave": [],
        "benefits": [],
    }

    response = client.post("/v1/jd/validate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert len(body["issues"]) > 0
