"""M05: AI question suggestions for one assessment round. HR reviews them; nothing is saved here."""
import json
import logging
import time

from pydantic import ValidationError

from ..llm_gateway import (
    LLMInvalidOutputError,
    LLMProvider,
    LLMTimeoutError,
    PromptSpec,
    escape_data,
    parse_json_object,
)
from .models import (
    GeneratedQuestion,
    GeneratedQuestions,
    RoundQuestionsRequest,
    RoundQuestionsResult,
)

log = logging.getLogger("ai_worker.rounds")

PROMPT_FILE = "round_questions.v1.yaml"
MAX_ATTEMPTS = 2  # one retry on invalid output (protects quota)


def generate_questions(req: RoundQuestionsRequest, provider: LLMProvider, prompt: PromptSpec, *, budget_seconds: float) -> RoundQuestionsResult:
    job = {k: v for k, v in req.job.model_dump().items() if v not in (None, [], "")}
    rendered = prompt.render(
        job=escape_data(json.dumps(job, ensure_ascii=False, indent=2)),
        round=escape_data(json.dumps(req.round.model_dump(), ensure_ascii=False, indent=2)),
        count=str(req.count),
        difficulty=req.difficulty,
        topics=escape_data(", ".join(req.topics) or "any topic that fits the round and the job"),
        kinds=", ".join(req.kinds),
        avoid=escape_data("\n".join(f"- {a}" for a in req.avoid[:50]) or "(none)"),
    )
    deadline = time.monotonic() + budget_seconds
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if time.monotonic() >= deadline:
            raise LLMTimeoutError()
        out = provider.generate_json(
            system=prompt.system, prompt=rendered, schema=GeneratedQuestions, temperature=prompt.temperature, deadline=deadline
        )
        try:
            parsed = GeneratedQuestions.model_validate(parse_json_object(out.text))
        except (ValueError, TypeError, ValidationError) as exc:
            log.warning("round questions invalid", extra={"attempt": attempt, "error_type": type(exc).__name__})
            continue
        return RoundQuestionsResult(questions=cleaned(parsed.questions, req), model=out.model, promptVersion=prompt.version)
    raise LLMInvalidOutputError()


def cleaned(questions: list[GeneratedQuestion], req: RoundQuestionsRequest) -> list[GeneratedQuestion]:
    """Light clean-up only (the API re-checks every question with the shared contract): asked kinds, no repeats,
    trimmed text, options only where they belong, at most `count`."""
    seen = {" ".join(a.lower().split()) for a in req.avoid}
    out: list[GeneratedQuestion] = []
    for q in questions:
        text = " ".join(q.text.split())
        key = text.lower()
        if not text or q.kind not in req.kinds or key in seen:
            continue
        seen.add(key)
        options = [" ".join(o.split()) for o in q.options] if q.kind == "MCQ" else []
        if q.kind == "TRUE_FALSE":
            options = ["True", "False"]
        out.append(
            q.model_copy(
                update={
                    "text": text,
                    "options": options,
                    "correct": sorted(set(q.correct)) if q.kind in ("MCQ", "TRUE_FALSE") else [],
                    "modelAnswer": (q.modelAnswer or "").strip() or None,
                    "language": ((q.language or "").strip() or None) if q.kind == "CODING" else None,
                    "marks": min(max(q.marks, 1), 100),
                    "difficulty": q.difficulty or req.difficulty,
                    "topics": [t.strip() for t in q.topics if t.strip()][:10],
                }
            )
        )
        if len(out) == req.count:
            break
    return out
