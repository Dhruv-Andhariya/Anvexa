"""Settings of the GD worker, read from the repo-root .env (the same file the API reads)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def find_repo_root(start: Path | None = None) -> Path:
    here = (start or Path(__file__)).resolve()
    for parent in [here, *here.parents]:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    return here.parents[2]


load_dotenv(find_repo_root() / ".env", override=False)


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str
    llm_model: str
    llm_fallback_models: tuple[str, ...]
    llm_timeout_seconds: float
    #: Whisper model of faster-whisper: tiny / base / small / medium (bigger = better + slower). CPU, int8.
    whisper_model: str
    whisper_language: str | None
    #: Where the API stores GD audio (the worker only reads files under it).
    storage_dir: Path
    #: Shared secret the API sends in x-worker-secret (empty = local only, no check).
    worker_secret: str
    #: Piper voice for the moderator (downloaded once into piper_dir).
    piper_voice: str
    piper_dir: Path

    def __repr__(self) -> str:  # never leak the key through logs / tracebacks
        return f"Settings(llm_model={self.llm_model!r}, whisper_model={self.whisper_model!r}, gemini_api_key={'***' if self.gemini_api_key else '<unset>'})"


def get_settings() -> Settings:
    home = Path.home() / ".hireflow"
    return Settings(
        gemini_api_key=os.environ.get("GEMINI_API_KEY", "").strip(),
        llm_model=os.environ.get("GD_LLM_MODEL", "").strip() or os.environ.get("LLM_MODEL", "").strip() or "gemini-2.5-flash",
        llm_fallback_models=tuple(m.strip() for m in os.environ.get("LLM_FALLBACK_MODELS", "").split(",") if m.strip()),
        llm_timeout_seconds=_float("GD_LLM_TIMEOUT_SECONDS", 120.0),
        whisper_model=os.environ.get("GD_WHISPER_MODEL", "").strip() or "base",
        whisper_language=os.environ.get("GD_WHISPER_LANGUAGE", "").strip() or "en",
        storage_dir=Path(os.environ.get("GD_STORAGE_DIR", "").strip() or home / "gd-recordings").resolve(),
        worker_secret=os.environ.get("GD_WORKER_SECRET", "").strip(),
        piper_voice=os.environ.get("GD_PIPER_VOICE", "").strip() or "en_US-lessac-medium",
        piper_dir=Path(os.environ.get("GD_PIPER_DIR", "").strip() or home / "piper-voices").resolve(),
    )
