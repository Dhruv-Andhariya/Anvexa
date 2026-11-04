"""AI technical interview - the AI parts. The API owns the conversation (clock, limits, when it ends, fallbacks); the
model only plans topics, transcribes an answer, picks the next question, and evaluates the finished transcript.
Separate calls on purpose (context building, planning, transcription, decision, evaluation are never one prompt):
  - transcription sees the audio and a spelling list ONLY (with context a model can invent an answer for silence),
  - the decision sees text only, the evaluation sees the saved transcript only.
Everything the model returns is checked here; anything off-limits or unverifiable is dropped rather than trusted.
"""
import json
import logging
import re
import time

from pydantic import BaseModel, ValidationError

from ..llm_gateway import (
    Attachment,
    LLMError,
    LLMInvalidOutputError,
    LLMProvider,
    LLMTimeoutError,
    PromptSpec,
    escape_data,
    parse_json_object,
)
from ..screening.interview import audio_mime
from .models import (
    DIMENSION_KEYS,
    AnswerEvaluation,
    Dimension,
    HrQuestion,
    InterviewJob,
    InterviewPlanRequest,
    InterviewPlanResult,
    InterviewReport,
    InterviewReportRequest,
    InterviewReportResult,
    InterviewResume,
    InterviewTurnRequest,
    InterviewTurnResult,
    PlanTopic,
    ReportDraft,
    TurnDecisionOut,
)
from .normalize import normalize_transcript

log = logging.getLogger("ai_worker.interview")

PLAN_PROMPT_FILE = "interview_plan.v1.yaml"
TRANSCRIBE_PROMPT_FILE = "interview_transcribe.v1.yaml"
TURN_PROMPT_FILE = "interview_turn.v1.yaml"
REPORT_PROMPT_FILE = "interview_report.v1.yaml"
MAX_ATTEMPTS = 2  # one retry on invalid output (protects quota)
MAX_QUESTION_CHARS = 350
# Two questions this similar (word overlap) count as a repeat.
REPEAT_SIMILARITY = 0.7


def _ask(provider: LLMProvider, prompt: PromptSpec, rendered: str, schema, deadline: float, thinking_budget=None, attachments=()):
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
            thinking_budget=thinking_budget,
        )
        try:
            return schema.model_validate(parse_json_object(out.text)), out.model
        except (ValueError, TypeError, ValidationError) as exc:
            # failure class only - outputs echo the candidate's words
            log.warning("interview output invalid", extra={"task": prompt.task, "attempt": attempt, "error_type": type(exc).__name__})
    raise LLMInvalidOutputError()


# ---------- context blocks (data for the prompts, escaped) ----------


def job_block(job: InterviewJob) -> str:
    data = {k: v for k, v in job.model_dump().items() if v not in (None, [], "")}
    return escape_data(json.dumps(data, ensure_ascii=False, indent=2))


def resume_block(resume: InterviewResume) -> str:
    data = resume.model_dump()
    data = {k: v for k, v in data.items() if v not in (None, [], "")}
    return escape_data(json.dumps(data, ensure_ascii=False, indent=2)) if data else "(no parsed resume available)"


def hr_block(questions: list[HrQuestion], *, with_answers: bool) -> str:
    rows = [
        {"question": q.text, "topics": q.topics, **({"expectedAnswer": q.expectedAnswer} if with_answers and q.expectedAnswer else {})}
        for q in questions
    ]
    return escape_data(json.dumps(rows, ensure_ascii=False, indent=2)) if rows else "[]"


def _clean(text: str | None, limit: int) -> str:
    return " ".join((text or "").split())[:limit]


def _key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def resume_refs(resume: InterviewResume) -> list[str]:
    """Everything a RESUME question may point at: project titles, organisations / roles, listed skills and the
    technologies of projects."""
    refs = [p.title for p in resume.projects]
    refs += [e.organization for e in resume.experience] + [e.role for e in resume.experience if e.role]
    refs += resume.skills + [t for p in resume.projects for t in p.technologies]
    refs += resume.certifications
    return [r for r in refs if _key(r)]


def matching_ref(ref: str | None, resume: InterviewResume) -> str | None:
    """The resume item `ref` names (exact, or one contains the other), else None: a reference the resume does not
    contain is never kept."""
    k = _key(ref or "")
    if len(k) < 2:
        return None
    for item in resume_refs(resume):
        ik = _key(item)
        if k == ik or (len(k) >= 4 and k in ik) or (len(ik) >= 4 and ik in k):
            return item
    return None


def one_question(text: str | None) -> str | None:
    q = _clean(text, 1000)
    if not q or len(q) > MAX_QUESTION_CHARS or "?" not in q or q.count("?") > 2:
        return None
    return q


def similarity(a: str, b: str) -> float:
    wa, wb = set(_key(a).split()), set(_key(b).split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def is_repeat(question: str, asked: list[str]) -> bool:
    return any(similarity(question, a) >= REPEAT_SIMILARITY for a in asked)


# ---------- the plan ----------


class _PlanTopicDraft(BaseModel):
    id: str = ""
    title: str = ""
    source: str = "JOB"
    resumeRef: str = ""
    skill: str = ""
    goal: str = ""
    question: str = ""
    priority: int = 2


class _PlanDraft(BaseModel):
    topics: list[_PlanTopicDraft] = []


def topic_count(minutes: int) -> int:
    """Roughly one planned topic per 2.5 minutes (follow-ups fill the rest), 4-12."""
    return max(4, min(12, round(minutes / 2.5)))


def plan_interview(req: InterviewPlanRequest, provider: LLMProvider, prompt: PromptSpec, *, budget_seconds: float) -> InterviewPlanResult:
    rendered = prompt.render(
        minutes=str(req.durationMinutes),
        topics=str(topic_count(req.durationMinutes)),
        first_name=escape_data(req.candidateFirstName or "the candidate"),
        job=job_block(req.job),
        resume=resume_block(req.resume),
        hr_questions=hr_block(req.hrQuestions, with_answers=False),
    )
    draft, model = _ask(provider, prompt, rendered, _PlanDraft, time.monotonic() + budget_seconds)
    return InterviewPlanResult(topics=checked_plan(draft, req), model=model, promptVersion=prompt.version)


def checked_plan(draft: _PlanDraft, req: InterviewPlanRequest) -> list[PlanTopic]:
    """Keeps only grounded, askable topics: a RESUME topic must name something the resume contains; every HR question
    is a topic (added as written when the model left it out); ids are re-numbered t1, t2..."""
    kept: list[PlanTopic] = []
    asked: list[str] = []
    for t in draft.topics:
        source = t.source.upper()
        if source not in ("RESUME", "JOB", "SCENARIO", "HR"):
            continue
        question = one_question(t.question)
        if not question or is_repeat(question, asked):
            continue
        ref = None
        if source == "RESUME":
            ref = matching_ref(t.resumeRef, req.resume)
            if ref is None:
                log.info("plan topic dropped: resume reference not in the resume")
                continue
        kept.append(
            PlanTopic(
                id="",
                title=_clean(t.title, 80) or _clean(t.skill, 80) or "Topic",
                source=source,  # type: ignore[arg-type]
                resumeRef=ref,
                skill=_clean(t.skill, 120) or None,
                goal=_clean(t.goal, 400),
                question=question,
                priority=min(3, max(1, t.priority)),
            )
        )
        asked.append(question)
    # every HR question is asked: add the ones the model did not turn into a topic
    hr_kept = [t for t in kept if t.source == "HR"]
    for q in req.hrQuestions:
        if any(similarity(q.text, t.question) >= 0.4 for t in hr_kept):
            continue
        text = _clean(q.text, MAX_QUESTION_CHARS)
        kept.append(
            PlanTopic(
                id="",
                title=_clean(", ".join(q.topics), 80) or "Question from the hiring team",
                source="HR",
                question=text if text.endswith("?") else f"{text.rstrip('.')}?",
                priority=1,
            )
        )
    limit = max(topic_count(req.durationMinutes), len(req.hrQuestions))
    kept = kept[:limit]
    return [t.model_copy(update={"id": f"t{i + 1}"}) for i, t in enumerate(kept)]


# ---------- one spoken answer ----------


class _Heard(BaseModel):
    audible: bool
    transcript: str = ""
    quality: str = "CLEAR"
    unclearTerms: list[str] = []


class _Decision(BaseModel):
    reading: str = "STRONG"
    action: str = "NEXT_TOPIC"
    question: str = ""
    topicId: str = ""
    newTopicTitle: str = ""
    newTopicSource: str = ""
    newTopicResumeRef: str = ""
    coveredTopicIds: list[str] = []


READINGS = {"STRONG", "DETAILED", "INCOMPLETE", "VAGUE", "INCORRECT", "OFF_TOPIC", "DONT_KNOW", "UNCLEAR_AUDIO", "READY"}


def process_turn(
    req: InterviewTurnRequest,
    audio: bytes,
    provider: LLMProvider,
    transcribe_prompt: PromptSpec,
    turn_prompt: PromptSpec,
    *,
    budget_seconds: float,
    thinking_budget: int | None = 0,
) -> InterviewTurnResult:
    deadline = time.monotonic() + budget_seconds
    mime = audio_mime(req.audio.mimeType)
    vocabulary = [_clean(v, 60) for v in req.vocabulary if _clean(v, 60)][:80]

    # 1. hear: the audio and a spelling list only
    heard, model = _ask(
        provider,
        transcribe_prompt,
        transcribe_prompt.render(terms=escape_data(", ".join(vocabulary)) or "(none)"),
        _Heard,
        deadline,
        thinking_budget,
        attachments=[Attachment(data=audio, mime_type=mime)],
    )
    transcript = _clean(heard.transcript, 8000)
    audible = heard.audible and bool(transcript)
    quality = heard.quality if heard.quality in ("CLEAR", "PARTLY_UNCLEAR", "UNCLEAR") else "PARTLY_UNCLEAR"
    unclear = [_clean(u, 60) for u in heard.unclearTerms if _clean(u, 60)][:5] if audible else []
    versions = transcribe_prompt.version

    decision = None
    # 2. decide (text only) - only when the API asks for it
    if audible and req.decide:
        try:
            raw, model = _ask(
                provider,
                turn_prompt,
                turn_prompt.render(
                    phase=req.timing.phase,
                    elapsed=_minutes(req.timing.elapsedSeconds),
                    minutes=str(req.timing.durationMinutes),
                    remaining=_minutes(req.timing.remainingSeconds),
                    follow_up_allowed="yes" if req.followUpAllowed else "no",
                    topic_id=req.question.topicId or "(none)",
                    question=escape_data(req.question.text),
                    answer=escape_data(transcript),
                    history=_history_block(req),
                    plan=_plan_block(req),
                    resume=resume_block(req.resume),
                    job=job_block(req.job),
                ),
                _Decision,
                deadline,
                thinking_budget,
            )
            decision = checked_decision(req, raw)
        except LLMError as exc:
            # the transcript is good (and saved by the API): it continues with the next planned topic
            log.warning("interview decision failed, plan fallback", extra={"error_code": exc.code})
            decision = TurnDecisionOut(reading=None, action="NEXT_TOPIC", question=None, topicId=None, newTopicTitle=None,
                                       newTopicSource=None, newTopicResumeRef=None, coveredTopicIds=[])
        versions = f"{versions}+{turn_prompt.version}"

    return InterviewTurnResult(
        audible=audible,
        transcript=transcript if audible else "",
        normalizedTranscript=normalize_transcript(transcript, vocabulary) if audible else "",
        quality=quality if audible else "UNCLEAR",
        unclearTerms=unclear,
        decision=decision,
        model=model,
        promptVersion=versions,
    )


def checked_decision(req: InterviewTurnRequest, d: _Decision) -> TurnDecisionOut:
    """The model's choice, limited to what is allowed now. A question that breaks a rule is dropped (None): the API
    then asks the next planned topic's question instead, so the interview never stalls on bad output."""
    reading = d.reading if d.reading in READINGS else None
    action = d.action if d.action in ("FOLLOW_UP", "CLARIFY", "NEXT_TOPIC", "CONCLUDE") else "NEXT_TOPIC"
    plan_ids = {t.id for t in req.plan}
    covered = set(req.coveredTopicIds)
    if action in ("FOLLOW_UP", "CLARIFY") and not req.followUpAllowed:
        action = "NEXT_TOPIC"
    if action == "CONCLUDE" and req.timing.phase == "CORE":
        action = "NEXT_TOPIC"
    if reading == "DONT_KNOW" and action == "FOLLOW_UP":
        action = "NEXT_TOPIC"  # never press the same point again

    question = one_question(d.question) if action != "CONCLUDE" else None
    asked = [t.question for t in req.history] + [req.question.text]
    if question and is_repeat(question, asked):
        question = None

    topic_id = None
    new_title = new_source = new_ref = None
    if action == "NEXT_TOPIC":
        if d.topicId in plan_ids and d.topicId not in covered and d.topicId != req.question.topicId:
            topic_id = d.topicId
        elif question and d.newTopicSource in ("RESUME", "JOB", "SCENARIO"):
            new_source = d.newTopicSource
            new_title = _clean(d.newTopicTitle, 80) or "Additional topic"
            if new_source == "RESUME":
                new_ref = matching_ref(d.newTopicResumeRef, req.resume)
                if new_ref is None:
                    question, new_source, new_title = None, None, None  # not grounded in this resume
        else:
            question = None  # a "next topic" that names no topic: take the plan's next one

    newly_covered = [i for i in d.coveredTopicIds if i in plan_ids]
    if action in ("NEXT_TOPIC", "CONCLUDE") and req.question.topicId in plan_ids:
        newly_covered.append(req.question.topicId)  # moving on from a topic covers it
    return TurnDecisionOut(
        reading=reading,  # type: ignore[arg-type]
        action=action,  # type: ignore[arg-type]
        question=question,
        topicId=topic_id,
        newTopicTitle=new_title,
        newTopicSource=new_source,  # type: ignore[arg-type]
        newTopicResumeRef=new_ref,
        coveredTopicIds=sorted(set(newly_covered)),
    )


def _minutes(seconds: int) -> str:
    return f"{seconds // 60}m {seconds % 60:02d}s"


def _history_block(req: InterviewTurnRequest) -> str:
    rows = [{"seq": t.seq, "topicId": t.topicId, "question": t.question, "answer": t.answer} for t in req.history[-14:]]
    return escape_data(json.dumps(rows, ensure_ascii=False, indent=2)) if rows else "[]"


def _plan_block(req: InterviewTurnRequest) -> str:
    covered = set(req.coveredTopicIds)
    rows = [
        {"id": t.id, "covered": t.id in covered, "priority": t.priority, "source": t.source, "title": t.title,
         "resumeRef": t.resumeRef, "goal": t.goal, "question": t.question}
        for t in req.plan
    ]
    return escape_data(json.dumps(rows, ensure_ascii=False, indent=2)) if rows else "[]"


# ---------- the report ----------

# Communication counts half: the interview is technical, and clarity is judged on content, never on accent.
WEIGHTS = {k: (0.5 if k == "COMMUNICATION_CLARITY" else 1.0) for k in DIMENSION_KEYS}
THRESHOLDS = ((80, "STRONGLY_RECOMMENDED"), (65, "RECOMMENDED"), (45, "NEEDS_HUMAN_REVIEW"))
MIN_ANSWERS = 3
UNCLEAR_SHARE = 0.3


def write_report(req: InterviewReportRequest, provider: LLMProvider, prompt: PromptSpec, *, budget_seconds: float) -> InterviewReportResult:
    turns = [t.model_dump() for t in req.turns]
    rendered = prompt.render(
        minutes=str(req.durationMinutes),
        used=str(round(req.usedSeconds / 60)),
        status=req.status,
        job=job_block(req.job),
        resume=resume_block(req.resume),
        hr_questions=hr_block(req.hrQuestions, with_answers=True),
        turns=escape_data(json.dumps(turns, ensure_ascii=False, indent=2)),
    )
    draft, model = _ask(provider, prompt, rendered, ReportDraft, time.monotonic() + budget_seconds)
    return InterviewReportResult(report=checked_report(draft, req), model=model, promptVersion=prompt.version)


def _quote_in(quote: str | None, answer: str) -> str | None:
    q = _clean(quote, 300)
    if len(q) < 3:
        return None
    norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s.lower())).strip()  # noqa: E731
    return q if norm(q) and norm(q) in norm(answer) else None


def _items(values: list[str], n: int = 10, limit: int = 300) -> list[str]:
    out: list[str] = []
    for v in values:
        c = _clean(v, limit)
        if c and c.casefold() not in {o.casefold() for o in out}:
            out.append(c)
    return out[:n]


def checked_report(d: ReportDraft, req: InterviewReportRequest) -> InterviewReport:
    """Evidence must point at real answers, quotes must be literally in them, a dimension without evidence has no
    score. The overall score and the label are computed here from the dimensions, never taken from the model."""
    answered = {t.seq: t for t in req.turns if t.kind not in ("INTRO", "CLOSING") and t.answer.strip()}
    answers: list[AnswerEvaluation] = []
    for a in d.answers:
        turn = answered.get(a.seq)
        if not turn or any(x.seq == a.seq for x in answers):
            continue
        unclear = turn.quality == "UNCLEAR"
        answers.append(
            AnswerEvaluation(
                seq=a.seq,
                # an answer whose words were not understood is never scored (a person reviews it)
                technicalAccuracy=None if unclear else a.technicalAccuracy,
                depth=None if unclear else a.depth,
                strengths=_items(a.strengths, 6),
                gaps=_items(a.gaps, 6) + (["The transcript of this answer is unclear - please review it."] if unclear else []),
                quote=_quote_in(a.quote, turn.answer),
                summary=_clean(a.summary, 400),
            )
        )
    answers.sort(key=lambda a: a.seq)

    by_key = {dim.key: dim for dim in d.dimensions}
    dimensions: list[Dimension] = []
    for key in DIMENSION_KEYS:
        dim = by_key.get(key)  # type: ignore[arg-type]
        evidence = sorted({e for e in (dim.evidence if dim else []) if e in answered})
        score = dim.score if dim and evidence else None
        dimensions.append(
            Dimension(key=key, score=None if score is None else round(score, 1), summary=_clean(dim.summary if dim else "", 400), evidence=evidence)  # type: ignore[arg-type]
        )

    scored = [(WEIGHTS[x.key], x.score) for x in dimensions if x.score is not None]
    overall = round(sum(w * s for w, s in scored) / sum(w for w, _ in scored) * 10) if scored else None

    notes = _items(d.uncertaintyNotes, 6)
    unclear_share = sum(1 for t in answered.values() if t.quality != "CLEAR") / len(answered) if answered else 0
    if len(answered) < MIN_ANSWERS:
        notes.append(f"Only {len(answered)} technical answer(s) were given: too few to judge reliably.")
    if unclear_share >= UNCLEAR_SHARE:
        notes.append("Many answers were transcribed with uncertainty: check them against the transcript.")
    if req.status == "INCOMPLETE":
        notes.append("The interview was not completed.")
    uncertain = overall is None or len(answered) < MIN_ANSWERS or unclear_share >= UNCLEAR_SHARE

    recommendation = "NOT_RECOMMENDED"
    for limit, label in THRESHOLDS:
        if overall is not None and overall >= limit:
            recommendation = label
            break
    if uncertain:
        recommendation = "NEEDS_HUMAN_REVIEW"

    return InterviewReport(
        overallScore=overall,
        dimensions=dimensions,
        answers=answers,
        strengths=_items(d.strengths),
        improvementAreas=_items(d.improvementAreas),
        skillsDemonstrated=_items(d.skillsDemonstrated, 20, 80),
        skillsNotVerified=_items(d.skillsNotVerified, 20, 80),
        recommendation=recommendation,  # type: ignore[arg-type]
        recommendationReason=_clean(d.recommendationReason, 600),
        uncertain=uncertain,
        uncertaintyNotes=_items(notes, 8),
        summary=_clean(d.summary, 800),
    )
