import json

from ai_worker.llm_gateway import LLMResult

VALID_JD = {
    "title": "Python Developer",
    "summary": "You will build and maintain backend services in a hybrid role based in Ahmedabad.",
    "aboutCompany": "",
    "responsibilities": [
        "Design and build REST APIs with FastAPI.",
        "Write efficient SQL queries and maintain database schemas.",
        "Review code and write automated tests.",
    ],
    "requirements": [
        "1-3 years of professional software development experience.",
        "Strong proficiency in Python.",
        "Hands-on experience with FastAPI.",
        "Working knowledge of SQL.",
    ],
    "niceToHave": ["Experience with Docker."],
    "benefits": [],
}


class FakeProvider:
    """Stands in for Gemini. Queue raw text responses or exceptions; records every call."""

    def __init__(self):
        self.outputs: list[str | Exception] = []
        self.calls: list[dict] = []

    def queue(self, *outputs: str | dict | Exception) -> "FakeProvider":
        for out in outputs:
            self.outputs.append(json.dumps(out) if isinstance(out, dict) else out)
        return self

    def generate_json(self, **kwargs) -> LLMResult:
        self.calls.append(kwargs)
        if not self.outputs:
            raise AssertionError("FakeProvider called more times than responses were queued")
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return LLMResult(text=out, model="fake-model")
