"""Settings of the AAIE worker, read from the environment and the repo-root .env (the same file the API reads).

Validated once, when the service starts: a wrong value stops the service with a message that names the variable but
never prints its value. Secrets (the shared worker secret, the Gemini API key) never appear in logs, tracebacks or
responses.

  AAIE_WORKER_HOST           default 127.0.0.1 (local only, like the other workers)
  AAIE_WORKER_PORT           default 8020
  AAIE_WORKER_SECRET         optional; when set, protected routes require it in the x-worker-secret header
                             (16-256 visible characters, no spaces). /health is always public.
  AAIE_WORKER_LOG_LEVEL      DEBUG | INFO | WARNING | ERROR (default INFO)
  GEMINI_API_KEY             the Gemini API key (shared with the other workers). Empty = AI not configured.
  AAIE_LLM_MODEL             the Gemini model for DSA evaluation. **No default** (open decision T1): empty = AI not
                             configured, and every evaluation that needs the AI returns RE-EVALUATE.
  AAIE_LLM_TIMEOUT_SECONDS   time-out of one Gemini call, 1-300 (default 60, provisional: open decision T5); a
                             time-out is RE-EVALUATE / AI_TIMEOUT, never a candidate failure
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from . import __version__

SERVICE_NAME = "aaie-worker"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8020
DEFAULT_LLM_TIMEOUT_SECONDS = 60.0
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
SECRET_MIN_LENGTH = 16
SECRET_MAX_LENGTH = 256
_SECRET_SHAPE = re.compile(r"^[\x21-\x7e]+$")  # visible ASCII, no whitespace
_HOST_SHAPE = re.compile(r"^[A-Za-z0-9.:\-]+$")
_MODEL_SHAPE = re.compile(r"^[A-Za-z0-9._\-/]{1,100}$")


def find_repo_root(start: Path | None = None) -> Path:
    here = (start or Path(__file__)).resolve()
    for parent in [here, *here.parents]:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    return here.parents[2]


# real environment variables win over the .env file (same rule as the other workers)
load_dotenv(find_repo_root() / ".env", override=False)


class ConfigError(ValueError):
    """A setting is invalid. The message names the variable, never its value."""


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    #: Shared secret the API sends in x-worker-secret (empty = no check, local only).
    worker_secret: str
    log_level: str
    gemini_api_key: str = ""
    #: Empty = not configured (no default model: open decision T1).
    llm_model: str = ""
    llm_timeout_seconds: float = DEFAULT_LLM_TIMEOUT_SECONDS
    service_name: str = SERVICE_NAME
    version: str = __version__

    @property
    def auth_enabled(self) -> bool:
        return bool(self.worker_secret)

    @property
    def ai_configured(self) -> bool:
        return bool(self.gemini_api_key and self.llm_model)

    def __repr__(self) -> str:  # never leak a secret through logs / tracebacks
        secret = "***" if self.worker_secret else "<unset>"
        key = "***" if self.gemini_api_key else "<unset>"
        return (
            f"Settings(host={self.host!r}, port={self.port}, worker_secret={secret}, "
            f"log_level={self.log_level!r}, gemini_api_key={key}, llm_model={self.llm_model or '<unset>'!r}, "
            f"llm_timeout_seconds={self.llm_timeout_seconds}, version={self.version!r})"
        )

    __str__ = __repr__


def _text(env: Mapping[str, str], name: str) -> str:
    return (env.get(name) or "").strip()


def _port(env: Mapping[str, str]) -> int:
    raw = _text(env, "AAIE_WORKER_PORT")
    if not raw:
        return DEFAULT_PORT
    if not raw.isdigit() or not 1 <= int(raw) <= 65535:
        raise ConfigError("AAIE_WORKER_PORT must be a whole number between 1 and 65535.")
    return int(raw)


def _host(env: Mapping[str, str]) -> str:
    raw = _text(env, "AAIE_WORKER_HOST")
    if not raw:
        return DEFAULT_HOST
    if len(raw) > 255 or not _HOST_SHAPE.match(raw):
        raise ConfigError("AAIE_WORKER_HOST must be a host name or IP address.")
    return raw


def _secret(env: Mapping[str, str]) -> str:
    raw = _text(env, "AAIE_WORKER_SECRET")
    if not raw:
        return ""
    if not SECRET_MIN_LENGTH <= len(raw) <= SECRET_MAX_LENGTH or not _SECRET_SHAPE.match(raw):
        raise ConfigError(
            f"AAIE_WORKER_SECRET must be {SECRET_MIN_LENGTH}-{SECRET_MAX_LENGTH} visible characters without spaces."
        )
    return raw


def _log_level(env: Mapping[str, str]) -> str:
    raw = _text(env, "AAIE_WORKER_LOG_LEVEL").upper()
    if not raw:
        return "INFO"
    if raw not in LOG_LEVELS:
        raise ConfigError(f"AAIE_WORKER_LOG_LEVEL must be one of {', '.join(LOG_LEVELS)}.")
    return raw


def _api_key(env: Mapping[str, str]) -> str:
    raw = _text(env, "GEMINI_API_KEY")
    if raw and not _SECRET_SHAPE.match(raw):
        raise ConfigError("GEMINI_API_KEY must not contain spaces or control characters.")
    return raw


def _model(env: Mapping[str, str]) -> str:
    raw = _text(env, "AAIE_LLM_MODEL")
    if raw and not _MODEL_SHAPE.match(raw):
        raise ConfigError("AAIE_LLM_MODEL must be a model name (letters, digits, . _ - /).")
    return raw


def _timeout(env: Mapping[str, str]) -> float:
    raw = _text(env, "AAIE_LLM_TIMEOUT_SECONDS")
    if not raw:
        return DEFAULT_LLM_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        value = -1.0
    if not 1 <= value <= 300:
        raise ConfigError("AAIE_LLM_TIMEOUT_SECONDS must be a number between 1 and 300.")
    return value


def get_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Reads and validates the settings (from os.environ unless a mapping is given). Raises ConfigError."""
    source = os.environ if env is None else env
    return Settings(
        host=_host(source),
        port=_port(source),
        worker_secret=_secret(source),
        log_level=_log_level(source),
        gemini_api_key=_api_key(source),
        llm_model=_model(source),
        llm_timeout_seconds=_timeout(source),
    )
