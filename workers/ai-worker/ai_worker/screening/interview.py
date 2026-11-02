"""M12 AI screening round - the AI parts of one spoken turn, and the structured summary at the end.

The API owns the conversation (which step comes next, how many follow-ups, when it ends). The model only:
  1. writes down what the candidate said - from the audio ALONE (no question, no history, no job: with context a model
     can "complete" a silent recording with a plausible answer; measured, so this is separate on purpose),
  2. says whether a short follow-up is needed for THIS step, and which (text only, skipped when none is allowed),
  3. in the last step, answers the candidate's question from the verified job information only.
Everything the model returns is checked here; anything off-limits is dropped rather than trusted.
"""
import json
import logging
import time

from pydantic import BaseModel, ValidationError

from ..llm_gateway import (
    Attachment,
    LLMInvalidOutputError,
    LLMProvider,
    LLMTimeoutError,
    PromptSpec,
    escape_data,
    parse_json_object,
)
from .models import (
    ScreeningExtraction,
    ScreeningExtractRequest,
    ScreeningExtractResult,
    ScreeningJob,
    ScreeningTurnRequest,
    ScreeningTurnResult,
)

log = logging.getLogger("ai_worker.screening")

TRANSCRIBE_PROMPT_FILE = "screening_transcribe.v1.yaml"
TURN_PROMPT_FILE = "screening_turn.v1.yaml"
EXTRACT_PROMPT_FILE = "screening_extract.v1.yaml"
MAX_ATTEMPTS = 2  # one retry on invalid output (protects quota)
MAX_QUESTION_CHARS = 300
MAX_REPLY_CHARS = 700

# Browsers record in containers Gemini knows under another name; codec parameters are dropped.
_MIME_ALIASES = {"audio/mp4": "audio/m4a", "audio/x-m4a": "audio/m4a", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav"}
ALLOWED_AUDIO = {"audio/webm", "audio/ogg", "audio/m4a", "audio/aac", "audio/mpeg", "audio/mp3", "audio/wav", "audio/opus", "audio/flac"}


class UnsupportedAudioError(ValueError):
    pass


def audio_mime(raw: str) -> str:
    base = raw.split(";", 1)[0].strip().lower()
    base = _MIME_ALIASES.get(base, base)
    if base not in ALLOWED_AUDIO:
        raise UnsupportedAudioError(base)
    return base


# ---------- what the model fills in for one turn ----------


class Transcription(BaseModel):
    audible: bool
    transcript: str = ""


class TurnDecision(BaseModel):
    needsFollowUp: bool = False
    followUpQuestion: str = ""
    candidateAskedQuestion: bool = False
    reply: str = ""
    candidateIsDone: bool = False


class TurnReading(Transcription, TurnDecision):
    pass


def process_turn(
    req: ScreeningTurnRequest,
    audio: bytes,
    provider: LLMProvider,
    transcribe_prompt: PromptSpec,
    turn_prompt: PromptSpec,
    *,
    budget_seconds: float,
    thinking_budget: int | None = 0,
) -> ScreeningTurnResult:
    deadline = time.monotonic() + budget_seconds
    mime = audio_mime(req.audio.mimeType)

    # 1. hear: the audio alone
    heard, model = _ask(
        provider,
        transcribe_prompt,
        transcribe_prompt.render(),
        Transcription,
        deadline,
        thinking_budget,
        attachments=[Attachment(data=audio, mime_type=mime)],
    )
    transcript = " ".join(heard.transcript.split())
    versions = transcribe_prompt.version
    decision = TurnDecision()
    # 2. decide (text only) - only when there is something to decide
    if heard.audible and transcript and (req.followUpAllowed or req.step == "CANDIDATE_QUESTIONS"):
        rendered = turn_prompt.render(
            step=req.step,
            kind=req.kind,
            question=escape_data(req.question),
            answer=escape_data(transcript),
            follow_up_allowed="yes" if req.followUpAllowed else "no",
            history=_history_block(req),
            job=job_block(req.job),
        )
        decision, model = _ask(provider, turn_prompt, rendered, TurnDecision, deadline, thinking_budget)
        versions = f"{versions}+{turn_prompt.version}"
    reading = TurnReading(audible=heard.audible, transcript=transcript, **decision.model_dump())
    return checked_turn(req, reading, model=model, prompt_version=versions)


def _ask(provider: LLMProvider, prompt: PromptSpec, rendered: str, schema, deadline: float, thinking_budget, attachments=()):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if time.monotonic() >= deadline:
            raise LLMTimeoutError()
        out = provider.generate_json(
            system=prompt.system,
            prompt=rendered,
            schema=schema,
            temperature=prompt.temperature,
            deadline=deadline,
            attachments=attachments,
            thinking_budget=thinking_budget,  # a live conversation: latency matters more than deliberation
        )
        try:
            return schema.model_validate(parse_json_object(out.text)), out.model
        except (ValueError, TypeError, ValidationError) as exc:
            # failure class only - the output echoes the candidate's words
            log.warning("screening turn invalid", extra={"task": prompt.task, "attempt": attempt, "error_type": type(exc).__name__})
    raise LLMInvalidOutputError()


def checked_turn(req: ScreeningTurnRequest, r: TurnReading, *, model: str, prompt_version: str) -> ScreeningTurnResult:
    """The model's reading, limited to what this step may do. Unknown stays unknown: an empty transcript is never filled."""
    transcript = " ".join(r.transcript.split())[:6000]
    audible = r.audible and bool(transcript)
    in_questions_step = req.step == "CANDIDATE_QUESTIONS"

    follow_up = _one_question(r.followUpQuestion)
    needs_follow_up = audible and req.followUpAllowed and not in_questions_step and r.needsFollowUp and follow_up is not None

    asked = audible and in_questions_step and r.candidateAskedQuestion
    reply = _clip(r.reply, MAX_REPLY_CHARS) if asked else None
    if asked and not reply:
        reply = "I don't have verified information about that. The HR team will be able to clarify it for you."
    done = in_questions_step and audible and (r.candidateIsDone or not asked)

    return ScreeningTurnResult(
        audible=audible,
        transcript=transcript if audible else "",
        needsFollowUp=needs_follow_up,
        followUpQuestion=follow_up if needs_follow_up else None,
        candidateAskedQuestion=asked,
        reply=reply,
        candidateIsDone=done,
        model=model,
        promptVersion=prompt_version,
    )


def _one_question(text: str) -> str | None:
    q = " ".join((text or "").split())
    if not q or len(q) > MAX_QUESTION_CHARS or "?" not in q:
        return None
    return q


def _clip(text: str, limit: int) -> str:
    t = " ".join((text or "").split())
    if len(t) <= limit:
        return t
    cut = t[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    return cut[: end + 1] if end > limit // 2 else cut.rstrip() + "…"


def _history_block(req: ScreeningTurnRequest) -> str:
    lines = [{"step": t.step, "question": t.question, "answer": t.answer} for t in req.history[-12:]]
    return escape_data(json.dumps(lines, ensure_ascii=False, indent=2)) if lines else "[]"


def job_block(job: ScreeningJob) -> str:
    data = job.model_dump()
    data = {k: v for k, v in data.items() if v not in (None, [], "")}
    return escape_data(json.dumps(data, ensure_ascii=False, indent=2))


# ---------- the structured summary ----------


def extract(req: ScreeningExtractRequest, provider: LLMProvider, prompt: PromptSpec, *, budget_seconds: float) -> ScreeningExtractResult:
    turns = [t.model_dump() for t in req.turns]
    rendered = prompt.render(job=job_block(req.job), transcript=escape_data(json.dumps(turns, ensure_ascii=False, indent=2)))
    deadline = time.monotonic() + budget_seconds
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if time.monotonic() >= deadline:
            raise LLMTimeoutError()
        out = provider.generate_json(
            system=prompt.system, prompt=rendered, schema=ScreeningExtraction, temperature=prompt.temperature, deadline=deadline
        )
        try:
            extraction = ScreeningExtraction.model_validate(parse_json_object(out.text))
        except (ValueError, TypeError, ValidationError) as exc:
            log.warning("screening extraction invalid", extra={"attempt": attempt, "error_type": type(exc).__name__})
            continue
        return ScreeningExtractResult(extraction=checked_extraction(extraction, req), model=out.model, promptVersion=prompt.version)
    raise LLMInvalidOutputError()


def checked_extraction(x: ScreeningExtraction, req: ScreeningExtractRequest) -> ScreeningExtraction:
    """Evidence must point at real turns; empty strings mean "not said" (null), never a guess."""
    seqs = {t.seq for t in req.turns}

    def ev(values: list[int]) -> list[int]:
        return sorted({v for v in values if v in seqs})

    def s(value: str | None, limit: int = 600) -> str | None:
        v = " ".join((value or "").split())
        return v[:limit] if v else None

    def items(values: list[str], n: int = 15) -> list[str]:
        out: list[str] = []
        for v in values:
            c = s(v, 300)
            if c and c.casefold() not in {o.casefold() for o in out}:
                out.append(c)
        return out[:n]

    return ScreeningExtraction(
        introduction=x.introduction.model_copy(
            update={"statedName": s(x.introduction.statedName, 120), "summary": s(x.introduction.summary), "evidence": ev(x.introduction.evidence)}
        ),
        education=x.education.model_copy(
            update={
                "degree": s(x.education.degree, 150),
                "fieldOfStudy": s(x.education.fieldOfStudy, 150),
                "institution": s(x.education.institution, 200),
                "currentYearOrSemester": s(x.education.currentYearOrSemester, 100),
                "expectedGraduation": s(x.education.expectedGraduation, 100),
                "evidence": ev(x.education.evidence),
            }
        ),
        background=x.background.model_copy(
            update={
                "projects": items(x.background.projects),
                "internshipsOrWork": items(x.background.internshipsOrWork),
                "interests": items(x.background.interests),
                "summary": s(x.background.summary),
                "evidence": ev(x.background.evidence),
            }
        ),
        location=x.location.model_copy(
            update={
                "currentLocation": s(x.location.currentLocation, 150),
                "relocationNotes": s(x.location.relocationNotes, 300),
                "evidence": ev(x.location.evidence),
            }
        ),
        availability=x.availability.model_copy(
            update={
                "currentStatus": s(x.availability.currentStatus, 300),
                "availability": s(x.availability.availability, 300),
                "joiningTimeline": s(x.availability.joiningTimeline, 200),
                "constraints": s(x.availability.constraints, 300),
                "evidence": ev(x.availability.evidence),
            }
        ),
        candidateQuestions=[
            q.model_copy(update={"question": s(q.question, 500) or "", "answerGiven": s(q.answerGiven, 800), "evidence": ev(q.evidence)})
            for q in x.candidateQuestions[:10]
            if s(q.question, 500)
        ],
        unclear=items(x.unclear, 10),
        summary=s(x.summary, 800),
    )
