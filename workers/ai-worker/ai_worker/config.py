"""Runtime configuration. Values come from the environment; the repo-root .env is loaded once at
startup so the worker behaves the same no matter which directory it is started from.
Real environment variables always win over .env values (override=False)."""
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

# ai_worker/config.py -> ai_worker -> ai-worker -> workers -> <repo root>
_REPO_ROOT_GUESS = Path(__file__).resolve().parents[3]


def find_repo_root(start: Path | None = None) -> Path:
    """Walk upwards until the monorepo marker (pnpm-workspace.yaml) is found."""
    here = (start or Path(__file__)).resolve()
    for candidate in [here, *here.parents]:
        if (candidate / "pnpm-workspace.yaml").is_file():
            return candidate
    return _REPO_ROOT_GUESS


@lru_cache(maxsize=1)
def load_env() -> Path | None:
    """Load <repo root>/.env (or $HIREFLOW_ENV_FILE). Returns the file loaded, if any."""
    explicit = os.environ.get("HIREFLOW_ENV_FILE")
    env_file = Path(explicit) if explicit else find_repo_root() / ".env"
    if env_file.is_file():
        load_dotenv(env_file, override=False)
        return env_file
    return None


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


@dataclass(frozen=True)
class Settings:
    llm_provider: str
    llm_model: str
    llm_fallback_models: tuple[str, ...]  # tried in order when llm_model is overloaded (5xx)
    gemini_api_key: str
    llm_timeout_seconds: float
    llm_transient_retries: int  # retries on 5xx only - 429 (quota) is never retried automatically
    jd_generation_budget_seconds: float  # total time for one JD (all attempts + fallbacks); below the API timeout
    prompts_dir: Path
    resume_screen_budget_seconds: float = 80.0  # total time for one resume; below the API's ATS timeout
    resume_ocr_fallback: bool = True  # scanned PDF (no text) -> the model reads the page images
    # M12 AI screening round (voice). The answer is heard + understood by llm_model (it reads audio);
    # the questions are spoken by a separate text-to-speech model.
    screening_tts_model: str = "gemini-3.8-flash-tts"
    screening_tts_voice: str = "Kore"
    # each TTS model has its own (small, on the free tier) quota: these are tried when the main one answers 429 / 5xx
    screening_tts_fallback_models: tuple[str, ...] = ("gemini-3.8-flash-lite-tts", "gemini-2.5-flash-preview-tts")
    screening_turn_budget_seconds: float = 25.0  # one spoken answer: transcript + follow-up decision
    screening_thinking_budget: int = 0  # model "thinking" tokens per turn: 0 = off (measured ~2x faster)
    screening_speech_budget_seconds: float = 20.0  # one question spoken
    screening_extract_budget_seconds: float = 60.0  # the structured summary after the screening
    round_questions_budget_seconds: float = 75.0  # M05 question suggestions; below the API's 90s timeout

    def __repr__(self) -> str:  # never leak the key through logs / tracebacks
        return (
            f"Settings(llm_provider={self.llm_provider!r}, llm_model={self.llm_model!r}, "
            f"gemini_api_key={'***' if self.gemini_api_key else '<unset>'})"
        )


def get_settings() -> Settings:
    """Read settings from the environment on every call (cheap, and keeps tests simple)."""
    return Settings(
        llm_provider=os.environ.get("LLM_PROVIDER", "").strip().lower(),
        llm_model=os.environ.get("LLM_MODEL", "").strip(),
        llm_fallback_models=tuple(
            m.strip() for m in os.environ.get("LLM_FALLBACK_MODELS", "").split(",") if m.strip()
        ),
        gemini_api_key=os.environ.get("GEMINI_API_KEY", "").strip(),
        llm_timeout_seconds=_float_env("LLM_TIMEOUT_SECONDS", 60.0),
        llm_transient_retries=max(0, _int_env("LLM_TRANSIENT_RETRIES", 1)),
        # the API gives up after AI_WORKER_TIMEOUT_MS (90s); stop retrying well before that
        jd_generation_budget_seconds=_float_env("JD_GENERATION_BUDGET_SECONDS", 80.0),
        prompts_dir=Path(os.environ.get("PROMPTS_DIR") or find_repo_root() / "prompts"),
        resume_screen_budget_seconds=_float_env("RESUME_SCREEN_BUDGET_SECONDS", 80.0),
        resume_ocr_fallback=_bool_env("RESUME_OCR_FALLBACK", True),
        screening_tts_model=os.environ.get("SCREENING_TTS_MODEL", "").strip() or "gemini-3.8-flash-tts",
        screening_tts_voice=os.environ.get("SCREENING_TTS_VOICE", "").strip() or "Kore",
        screening_tts_fallback_models=tuple(
            m.strip()
            for m in (os.environ.get("SCREENING_TTS_FALLBACK_MODELS") or "gemini-3.8-flash-lite-tts,gemini-2.5-flash-preview-tts").split(",")
            if m.strip()
        ),
        screening_turn_budget_seconds=_float_env("SCREENING_TURN_BUDGET_SECONDS", 25.0),
        screening_thinking_budget=max(0, _int_env("SCREENING_THINKING_BUDGET", 0)),
        screening_speech_budget_seconds=_float_env("SCREENING_SPEECH_BUDGET_SECONDS", 20.0),
        screening_extract_budget_seconds=_float_env("SCREENING_EXTRACT_BUDGET_SECONDS", 60.0),
        round_questions_budget_seconds=_float_env("ROUND_QUESTIONS_BUDGET_SECONDS", 75.0),
    )
