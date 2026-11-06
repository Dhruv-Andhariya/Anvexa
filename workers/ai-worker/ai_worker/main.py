"""AI worker HTTP API. /v1/jd/generate, /v1/resume/screen and /v1/screening/* are real (Gemini via llm_gateway);
/v1/jd/validate still runs rule checks only - Intern 2 adds the LLM bias check, URL and shape stay the same."""
import base64
import binascii
import logging
import time
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import JSONResponse

from .config import get_settings, load_env
from .interview import PLAN_PROMPT_FILE as INTERVIEW_PLAN_PROMPT_FILE
from .interview import REPORT_PROMPT_FILE as INTERVIEW_REPORT_PROMPT_FILE
from .interview import TRANSCRIBE_PROMPT_FILE as INTERVIEW_TRANSCRIBE_PROMPT_FILE
from .interview import TURN_PROMPT_FILE as INTERVIEW_TURN_PROMPT_FILE
from .interview import (
    InterviewPlanRequest,
    InterviewPlanResult,
    InterviewReportRequest,
    InterviewReportResult,
    InterviewTurnRequest,
    InterviewTurnResult,
    plan_interview,
    process_turn,
    write_report,
)
from .jd import PROMPT_FILE
from .jd import generate_jd as run_jd_generation
from .llm_gateway import LLMError, LLMProvider, PromptSpec, build_provider, load_prompt
from .parsing import (
    PDF,
    TRANSCRIBE_PROMPT_FILE,
    ResumeHasNoTextError,
    ResumeUnreadableError,
    extract_text,
    transcribe_resume,
)
from .rounds import PROMPT_FILE as ROUND_QUESTIONS_PROMPT_FILE
from .rounds import RoundQuestionsRequest, RoundQuestionsResult
from .rounds import generate_questions as run_round_questions
from .rounds.coding import PROMPT_FILE as CODING_PROBLEMS_PROMPT_FILE
from .rounds.coding import CodingProblemsRequest, CodingProblemsResult
from .rounds.coding import coding_problems as run_coding_problems
from .schemas import (
    JdContent,
    JdGenerateRequest,
    JdValidation,
    ResumeScreenRequest,
    ResumeScreenResult,
)
from .scoring import PROMPT_FILE as SCREEN_PROMPT_FILE
from .scoring import screen_resume as run_resume_screen
from .screening import (
    EXTRACT_PROMPT_FILE,
    TURN_PROMPT_FILE,
    ScreeningExtractRequest,
    ScreeningExtractResult,
    ScreeningTurnRequest,
    ScreeningTurnResult,
    SpeakRequest,
    UnsupportedAudioError,
)
from .screening import TRANSCRIBE_PROMPT_FILE as SCREENING_TRANSCRIBE_PROMPT_FILE
from .screening import extract as run_screening_extract
from .screening import process_turn as run_screening_turn
from .speech import SpeechProvider, build_speech_provider

load_env()  # repo-root .env, regardless of the working directory the worker starts in
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="ANVEXA worker", version="0.1.0")


@app.exception_handler(LLMError)
async def llm_error_handler(_request: Request, exc: LLMError) -> JSONResponse:
    headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": {"code": exc.code, "message": exc.message}},
        headers=headers,
    )


@app.exception_handler(ResumeUnreadableError)
async def resume_unreadable_handler(_request: Request, exc: ResumeUnreadableError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": {"code": exc.code, "message": exc.message}})


def get_llm_provider() -> Callable[[], LLMProvider]:
    """Returns a factory so a missing API key surfaces only AFTER input validation passed."""
    return lambda: build_provider(get_settings())


def get_jd_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / PROMPT_FILE)


def get_screen_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / SCREEN_PROMPT_FILE)


def get_transcribe_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / TRANSCRIBE_PROMPT_FILE)


def get_speech_provider() -> Callable[[], SpeechProvider]:
    return lambda: build_speech_provider(get_settings())


def get_screening_turn_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / TURN_PROMPT_FILE)


def get_screening_transcribe_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / SCREENING_TRANSCRIBE_PROMPT_FILE)


def get_screening_extract_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / EXTRACT_PROMPT_FILE)


def get_round_questions_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / ROUND_QUESTIONS_PROMPT_FILE)


def get_coding_problems_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / CODING_PROBLEMS_PROMPT_FILE)


def get_interview_plan_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / INTERVIEW_PLAN_PROMPT_FILE)


def get_interview_transcribe_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / INTERVIEW_TRANSCRIBE_PROMPT_FILE)


def get_interview_turn_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / INTERVIEW_TURN_PROMPT_FILE)


def get_interview_report_prompt() -> PromptSpec:
    return load_prompt(get_settings().prompts_dir / INTERVIEW_REPORT_PROMPT_FILE)


def _audio_error(message: str) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": {"code": "AUDIO_UNREADABLE", "message": message}})


@app.get("/health")
def health():
    return {"status": "ok", "service": "ai-worker"}


@app.post("/v1/jd/generate", response_model=JdContent)
def generate_jd(  # M02 - body: JobForm fields + optional "company" (the saved CompanyProfile)
    job_form: JdGenerateRequest,
    response: Response,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    prompt: Annotated[PromptSpec, Depends(get_jd_prompt)],
):
    result = run_jd_generation(
        job_form,
        provider_factory(),
        prompt,
        company=job_form.company,
        budget_seconds=get_settings().jd_generation_budget_seconds,
    )
    response.headers["X-LLM-Model"] = result.model
    response.headers["X-Prompt-Version"] = result.prompt_version
    return result.content


@app.post("/v1/jd/validate", response_model=JdValidation)
def validate_jd(jd: dict):  # M03 - TODO(Intern 2): rule checks + LLM bias check
    issues = []
    required_fields = [
        ("title", "MISSING_TITLE", "Job title is required."),
        ("summary", "MISSING_SUMMARY", "Job summary is required."),
        (
            "responsibilities",
            "MISSING_RESPONSIBILITIES",
            "At least one responsibility is required.",
        ),
        (
            "requirements",
            "MISSING_REQUIREMENTS",
            "At least one requirement is required.",
        ),
    ]

    for field, code, message in required_fields:
        value = jd.get(field)

        if isinstance(value, str):
            is_missing = not value.strip()
        else:
            is_missing = not value

        if is_missing:
            issues.append({
                "severity": "error",
                "code": code,
                "message": message,
            })

    return JdValidation(
        valid=not issues,
        issues=issues,
    )


@app.post("/v1/resume/screen", response_model=ResumeScreenResult)
def screen_resume(  # M10 + M11: resume file + approved JD -> parsed resume + explainable ATS score
    body: ResumeScreenRequest,
    response: Response,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    prompt: Annotated[PromptSpec, Depends(get_screen_prompt)],
    transcribe_prompt: Annotated[PromptSpec, Depends(get_transcribe_prompt)],
):
    settings = get_settings()
    try:
        data = base64.b64decode(body.resume.contentBase64, validate=True)
    except (binascii.Error, ValueError):
        raise ResumeUnreadableError("The resume file could not be decoded.") from None
    deadline = time.monotonic() + settings.resume_screen_budget_seconds  # one budget for transcript + screening
    transcript = None
    try:
        text = extract_text(data, body.resume.mimeType)  # 422 RESUME_UNREADABLE before any AI call
    except ResumeHasNoTextError:
        # a scanned PDF: the model reads the page images. Damaged / locked files and DOCX never get here.
        if body.resume.mimeType != PDF or not settings.resume_ocr_fallback:
            raise
        transcript = transcribe_resume(data, provider_factory(), transcribe_prompt, deadline=deadline)
        text = transcript.text
    result = run_resume_screen(text, body.job, body.jd, provider_factory(), prompt, deadline=deadline)
    if transcript is not None:  # stored with the score, so a score from a scan can always be told apart
        result = result.model_copy(update={"promptVersion": f"{result.promptVersion}+{transcript.prompt_version}"})
    response.headers["X-LLM-Model"] = result.model
    response.headers["X-Prompt-Version"] = result.promptVersion
    response.headers["X-Resume-Text-Source"] = "scan" if transcript is not None else "file"
    return result


@app.post("/v1/screening/turn", response_model=ScreeningTurnResult)
def screening_turn(  # M12: one spoken answer -> transcript + follow-up decision (+ reply to the candidate's question)
    body: ScreeningTurnRequest,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    transcribe_prompt: Annotated[PromptSpec, Depends(get_screening_transcribe_prompt)],
    prompt: Annotated[PromptSpec, Depends(get_screening_turn_prompt)],
):
    try:
        audio = base64.b64decode(body.audio.contentBase64, validate=True)
    except (binascii.Error, ValueError):
        return _audio_error("The recording could not be decoded.")
    if len(audio) < 200:
        return _audio_error("The recording is empty.")
    try:
        settings = get_settings()
        return run_screening_turn(
            body,
            audio,
            provider_factory(),
            transcribe_prompt,
            prompt,
            budget_seconds=settings.screening_turn_budget_seconds,
            thinking_budget=settings.screening_thinking_budget,
        )
    except UnsupportedAudioError:
        return _audio_error("This audio format is not supported.")


@app.post("/v1/screening/speak")
def screening_speak(  # M12: the AI interviewer's words -> audio/wav
    body: SpeakRequest,
    speech_factory: Annotated[Callable[[], SpeechProvider], Depends(get_speech_provider)],
):
    settings = get_settings()
    result = speech_factory().synthesize(body.text, deadline=time.monotonic() + settings.screening_speech_budget_seconds)
    return Response(content=result.data, media_type=result.mime_type, headers={"X-TTS-Model": result.model})


@app.post("/v1/screening/extract", response_model=ScreeningExtractResult)
def screening_extract(  # M12: finished transcript -> structured notes for HR (no score, no decision)
    body: ScreeningExtractRequest,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    prompt: Annotated[PromptSpec, Depends(get_screening_extract_prompt)],
):
    return run_screening_extract(body, provider_factory(), prompt, budget_seconds=get_settings().screening_extract_budget_seconds)


@app.post("/v1/interview/plan", response_model=InterviewPlanResult)
def interview_plan(  # AI technical interview: resume + job + HR questions -> the topics to cover
    body: InterviewPlanRequest,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    prompt: Annotated[PromptSpec, Depends(get_interview_plan_prompt)],
):
    return plan_interview(body, provider_factory(), prompt, budget_seconds=get_settings().interview_plan_budget_seconds)


@app.post("/v1/interview/turn", response_model=InterviewTurnResult)
def interview_turn(  # AI technical interview: one spoken answer -> raw + normalised transcript + the next question
    body: InterviewTurnRequest,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    transcribe_prompt: Annotated[PromptSpec, Depends(get_interview_transcribe_prompt)],
    prompt: Annotated[PromptSpec, Depends(get_interview_turn_prompt)],
):
    try:
        audio = base64.b64decode(body.audio.contentBase64, validate=True)
    except (binascii.Error, ValueError):
        return _audio_error("The recording could not be decoded.")
    if len(audio) < 200:
        return _audio_error("The recording is empty.")
    try:
        settings = get_settings()
        return process_turn(
            body,
            audio,
            provider_factory(),
            transcribe_prompt,
            prompt,
            budget_seconds=settings.interview_turn_budget_seconds,
            thinking_budget=settings.interview_thinking_budget,
        )
    except UnsupportedAudioError:
        return _audio_error("This audio format is not supported.")


@app.post("/v1/interview/speak")
def interview_speak(  # AI technical interview: the interviewer's words -> audio/wav (same TTS as the screening)
    body: SpeakRequest,
    speech_factory: Annotated[Callable[[], SpeechProvider], Depends(get_speech_provider)],
):
    settings = get_settings()
    result = speech_factory().synthesize(body.text, deadline=time.monotonic() + settings.screening_speech_budget_seconds)
    return Response(content=result.data, media_type=result.mime_type, headers={"X-TTS-Model": result.model})


@app.post("/v1/interview/report", response_model=InterviewReportResult)
def interview_report(  # AI technical interview: saved transcript -> evidence-based report for HR (advice only)
    body: InterviewReportRequest,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    prompt: Annotated[PromptSpec, Depends(get_interview_report_prompt)],
):
    return write_report(body, provider_factory(), prompt, budget_seconds=get_settings().interview_report_budget_seconds)


@app.post("/v1/rounds/questions", response_model=RoundQuestionsResult)
def round_questions(  # M05: question suggestions for one assessment round (HR reviews them; nothing is saved)
    body: RoundQuestionsRequest,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    prompt: Annotated[PromptSpec, Depends(get_round_questions_prompt)],
):
    return run_round_questions(body, provider_factory(), prompt, budget_seconds=get_settings().round_questions_budget_seconds)


@app.post("/v1/rounds/coding-problems", response_model=CodingProblemsResult)
def coding_problems(  # DSA coding round: new problems, or the problems of HR's PDF / Word file (HR reviews them; nothing is saved)
    body: CodingProblemsRequest,
    provider_factory: Annotated[Callable[[], LLMProvider], Depends(get_llm_provider)],
    prompt: Annotated[PromptSpec, Depends(get_coding_problems_prompt)],
):
    return run_coding_problems(body, provider_factory(), prompt, budget_seconds=get_settings().coding_problems_budget_seconds)
