"""The AI call, behind a small interface so tests never need Gemini or an API key.

GeminiClient follows workers/ai-worker's conventions (official google-genai SDK, JSON structured output with a
response schema, automatic function calling off, every SDK / transport failure turned into a safe typed error, logs
with metadata only - never prompts, code, outputs or credentials). There are **no automatic retries** here (open
decision T5); a failure is reported once and the caller returns RE-EVALUATE.
"""

from __future__ import annotations

import logging
import time
from typing import Protocol

import httpx
from pydantic import BaseModel

log = logging.getLogger("aaie_worker.llm")

_BLOCKED_FINISH_REASONS = {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"}

try:  # the SDK accepts either httpx or its httpx2 fork (same handling as workers/ai-worker)
    import httpx2  # type: ignore[import-not-found]

    _TIMEOUT_EXC: tuple[type[Exception], ...] = (httpx.TimeoutException, httpx2.TimeoutException)
    _CONNECT_EXC: tuple[type[Exception], ...] = (httpx.TransportError, httpx2.TransportError)
except ImportError:  # pragma: no cover - depends on installed extras
    _TIMEOUT_EXC = (httpx.TimeoutException,)
    _CONNECT_EXC = (httpx.TransportError,)


class LLMError(Exception):
    """Base of every AI failure. str() is a fixed, safe message - never provider text."""

    safe_message = "The AI evaluation failed."

    def __str__(self) -> str:
        return self.safe_message


class LLMNotConfiguredError(LLMError):
    safe_message = "The AI evaluation is not configured on the AAIE worker."


class LLMTimeoutError(LLMError):
    safe_message = "The AI evaluation timed out."


class LLMUnavailableError(LLMError):
    safe_message = "The AI service is unavailable."


class LLMBlockedError(LLMError):
    safe_message = "The AI service declined to evaluate this submission."


class LLMInvalidOutputError(LLMError):
    safe_message = "The AI service returned an unusable reply."


class LLMClient(Protocol):
    """Returns the raw JSON text of a structured reply. Raises an LLMError subclass on any failure."""

    model: str

    def generate_json(self, *, system: str, prompt: str, schema: type[BaseModel], temperature: float) -> str: ...


class GeminiClient:
    def __init__(self, *, api_key: str, model: str, timeout_seconds: float, client=None):
        if not api_key or not model:
            raise LLMNotConfiguredError()
        self.model = model
        self._timeout_seconds = timeout_seconds
        #: The SDK takes the time-out in milliseconds; at least 1 ms.
        self._timeout_ms = max(1, int(timeout_seconds * 1000))
        if client is None:
            from google import genai
            from google.genai import types

            client = genai.Client(
                api_key=api_key,
                # one attempt only: retries are an open decision (T5)
                http_options=types.HttpOptions(timeout=self._timeout_ms, retry_options=types.HttpRetryOptions(attempts=1)),
            )
        self._client = client

    def generate_json(self, *, system: str, prompt: str, schema: type[BaseModel], temperature: float) -> str:
        from google.genai import errors as genai_errors
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=temperature,
            response_mime_type="application/json",
            response_schema=schema,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            # the same time-out on every request (not only on the client), still one attempt: the configured limit
            # holds even for a client built elsewhere, and a time-out becomes RE-EVALUATE / AI_TIMEOUT
            http_options=types.HttpOptions(timeout=self._timeout_ms, retry_options=types.HttpRetryOptions(attempts=1)),
        )
        started = time.monotonic()
        try:
            response = self._client.models.generate_content(model=self.model, contents=prompt, config=config)
        except _TIMEOUT_EXC as exc:
            self._log("timeout", started)
            raise LLMTimeoutError() from exc
        except _CONNECT_EXC as exc:
            self._log("transport_error", started)
            raise LLMUnavailableError() from exc
        except genai_errors.APIError as exc:
            code = getattr(exc, "code", None)
            self._log(f"api_error_{code}", started)
            if code in (401, 403):
                raise LLMNotConfiguredError() from exc
            if code == 408 or code == 504:
                raise LLMTimeoutError() from exc
            raise LLMUnavailableError() from exc
        except Exception as exc:  # any other SDK failure is "unavailable", never leaked
            self._log("unexpected_error", started)
            raise LLMUnavailableError() from exc

        candidates = getattr(response, "candidates", None) or []
        finish = str(getattr(candidates[0], "finish_reason", "") or "") if candidates else ""
        if any(reason in finish for reason in _BLOCKED_FINISH_REASONS):
            self._log("blocked", started)
            raise LLMBlockedError()
        text = getattr(response, "text", None)
        if not isinstance(text, str) or not text.strip():
            self._log("empty_output", started)
            raise LLMInvalidOutputError()
        self._log("ok", started)
        return text

    def _log(self, status: str, started: float) -> None:
        log.info(
            "llm call",
            extra={"model": self.model, "status": status, "latency_ms": round((time.monotonic() - started) * 1000)},
        )
