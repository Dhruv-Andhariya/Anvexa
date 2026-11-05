"""DSA coding round: coding problems for HR - written by the AI ("generate") or read out of a document HR uploaded
("extract"). Each problem comes with a Python reference solution and test inputs; the API runs that solution on the
code runner to compute the expected outputs, so outputs from the model are never trusted blindly. Nothing is saved."""
import base64
import binascii
import json
import logging
import time
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from ..llm_gateway import LLMInvalidOutputError, LLMProvider, LLMTimeoutError, PromptSpec, escape_data, parse_json_object
from ..parsing.extract import DOCX, PDF, ResumeUnreadableError, _docx_text, _normalize, _pdf_text
from .models import Difficulty, QuestionJob

log = logging.getLogger("ai_worker.rounds.coding")

PROMPT_FILE = "coding_problems.v2.yaml"
MAX_ATTEMPTS = 2
DOCUMENT_MAX_CHARS = 40_000
DOCUMENT_MIN_CHARS = 40
PLAIN = "text/plain"


class DocumentUnreadableError(ResumeUnreadableError):
    """The uploaded file cannot be read (422, the API shows the message to HR)."""

    code = "DOCUMENT_UNREADABLE"


class CodingDocument(BaseModel):
    contentBase64: str = Field(min_length=1)
    mimeType: Literal["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"]


class CodingProblemsRequest(BaseModel):
    mode: Literal["generate", "extract"]
    job: QuestionJob
    count: int = Field(default=3, ge=1, le=5)
    difficulty: Difficulty = "MEDIUM"
    topics: list[str] = Field(default_factory=list, max_length=10)
    avoid: list[str] = Field(default_factory=list, max_length=100)
    document: CodingDocument | None = None


class CodingSample(BaseModel):
    input: str = Field(max_length=5000)
    output: str = Field(max_length=5000)


class CodingProblem(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    statement: str = Field(min_length=1, max_length=8000)
    inputFormat: str = Field(default="", max_length=2000)
    outputFormat: str = Field(default="", max_length=2000)
    constraints: str = Field(default="", max_length=2000)
    difficulty: Difficulty = "MEDIUM"
    marks: int = Field(default=10, ge=1, le=1000)
    referenceSolution: str = Field(default="", max_length=20000)
    samples: list[CodingSample] = Field(default_factory=list, max_length=5)
    hiddenInputs: list[str] = Field(default_factory=list, max_length=10)


class CodingProblems(BaseModel):
    problems: list[CodingProblem]


class CodingProblemsResult(BaseModel):
    problems: list[CodingProblem]
    model: str
    promptVersion: str


def document_text(doc: CodingDocument) -> str:
    """Plain text of a PDF / Word file (or text HR's CSV import could not map), cut to what the model may read."""
    try:
        data = base64.b64decode(doc.contentBase64, validate=True)
    except (binascii.Error, ValueError):
        raise DocumentUnreadableError("The file could not be decoded.") from None
    try:
        if doc.mimeType == PDF:
            text = _pdf_text(data)
        elif doc.mimeType == DOCX:
            text = _docx_text(data)
        else:
            text = data.decode("utf-8", errors="replace")
    except ResumeUnreadableError as exc:
        raise DocumentUnreadableError(exc.message.replace("resume", "file").replace("Resume", "File")) from None
    text = _normalize(text)
    if len(text) < DOCUMENT_MIN_CHARS:
        raise DocumentUnreadableError("The file has no readable text (it may be a scanned image). Upload a text PDF or a Word file.")
    return text[:DOCUMENT_MAX_CHARS]


TASKS = {
    "generate": "Write {count} NEW problem(s) for this job. Difficulty: {difficulty}. Do not use the document.",
    "extract": (
        "Read the programming problems out of the document below - every problem it contains, at most {count}. Keep "
        "each statement, its examples (as samples, with their outputs exactly as written in the document) and its "
        "marks if the document states them. Add the reference solution and hidden test inputs yourself. Do not invent "
        "problems that are not in the document."
    ),
}


def coding_problems(req: CodingProblemsRequest, provider: LLMProvider, prompt: PromptSpec, *, budget_seconds: float) -> CodingProblemsResult:
    document = ""
    if req.mode == "extract":
        if req.document is None:
            raise DocumentUnreadableError("Upload a file to read the problems from.")
        document = document_text(req.document)
    job = {k: v for k, v in req.job.model_dump().items() if v not in (None, [], "")}
    rendered = prompt.render(
        task=TASKS[req.mode].format(count=req.count if req.mode == "generate" else 10, difficulty=req.difficulty),
        job=escape_data(json.dumps(job, ensure_ascii=False, indent=2)),
        topics=escape_data(", ".join(req.topics) or "any data structures and algorithms topic that fits the job"),
        avoid=escape_data("\n".join(f"- {a}" for a in req.avoid[:50]) or "(none)"),
        document=escape_data(document),
    )
    deadline = time.monotonic() + budget_seconds
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if time.monotonic() >= deadline:
            raise LLMTimeoutError()
        out = provider.generate_json(system=prompt.system, prompt=rendered, schema=CodingProblems, temperature=prompt.temperature, deadline=deadline)
        try:
            parsed = CodingProblems.model_validate(parse_json_object(out.text))
        except (ValueError, TypeError, ValidationError) as exc:
            log.warning("coding problems invalid", extra={"attempt": attempt, "error_type": type(exc).__name__})
            continue
        limit = req.count if req.mode == "generate" else 10
        return CodingProblemsResult(problems=cleaned(parsed.problems, req.avoid)[:limit], model=out.model, promptVersion=prompt.version)
    raise LLMInvalidOutputError()


def cleaned(problems: list[CodingProblem], avoid: list[str]) -> list[CodingProblem]:
    """No repeats (by title), trimmed text. The API checks everything again and runs the reference solutions."""
    seen = {" ".join(a.lower().split()) for a in avoid}
    out: list[CodingProblem] = []
    for p in problems:
        key = " ".join(p.title.lower().split())
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(p.model_copy(update={"title": p.title.strip(), "statement": p.statement.strip(), "hiddenInputs": [h for h in p.hiddenInputs if h.strip()]}))
    return out
