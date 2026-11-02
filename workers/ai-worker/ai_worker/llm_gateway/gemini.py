"""Gemini provider (official google-genai SDK). Translates every SDK/transport failure into a
safe LLMError. Logs metadata only (model, latency, status, token counts) - never prompts,
outputs, or credentials."""
import logging
import re
import time
from collections.abc import Sequence

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

from .errors import (
    LLMAuthError,
    LLMBlockedError,
    LLMError,
    LLMInvalidOutputError,
    LLMNotConfiguredError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUnavailableError,
)
from .provider import Attachment, LLMResult

log = logging.getLogger("ai_worker.llm")

_TRANSIENT_STATUS_CODES = [500, 502, 503, 504]  # 429 deliberately excluded: respect quota
_BLOCKED_FINISH_REASONS = {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"}

try:  # the SDK accepts either httpx or its httpx2 fork
    import httpx2  # type: ignore[import-not-found]

    _TIMEOUT_EXC: tuple[type[Exception], ...] = (httpx.TimeoutException, httpx2.TimeoutException)
    _CONNECT_EXC: tuple[type[Exception], ...] = (httpx.TransportError, httpx2.TransportError)
except ImportError:  # pragma: no cover - depends on installed extras
    _TIMEOUT_EXC = (httpx.TimeoutException,)
    _CONNECT_EXC = (httpx.TransportError,)


class GeminiProvider:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        timeout_seconds: float = 60.0,
        transient_retries: int = 1,
        fallback_models: tuple[str, ...] = (),
        client: genai.Client | None = None,
    ):
        if not api_key:
            raise LLMNotConfiguredError("GEMINI_API_KEY is not set on the AI worker.")
        if not model:
            raise LLMNotConfiguredError("LLM_MODEL is not set on the AI worker.")
        self.model = model
        self._timeout_seconds = timeout_seconds
        self._attempts = 1 + transient_retries
        # Tried in order only when the previous model is overloaded / unreachable (5xx, transport)
        # or out of quota (429 - Gemini quotas are per model, so the next model has its own).
        self.fallback_models = tuple(m for m in fallback_models if m and m != model)
        self._client = client or genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(
                timeout=int(timeout_seconds * 1000),
                retry_options=types.HttpRetryOptions(
                    attempts=1 + transient_retries,
                    http_status_codes=_TRANSIENT_STATUS_CODES,
                ),
            ),
        )

    def generate_json(
        self,
        *,
        system: str,
        prompt: str,
        schema: type[BaseModel],
        temperature: float,
        deadline: float | None = None,
        attachments: Sequence[Attachment] = (),
        thinking_budget: int | None = None,
    ) -> LLMResult:
        contents: str | list = prompt
        if attachments:
            contents = [types.Part.from_bytes(data=a.data, mime_type=a.mime_type) for a in attachments]
            contents.append(prompt)
        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=temperature,
            response_mime_type="application/json",
            response_schema=schema,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            thinking_config=types.ThinkingConfig(thinking_budget=thinking_budget) if thinking_budget is not None else None,
        )
        models = (self.model, *self.fallback_models)
        for index, model in enumerate(models):
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    log.warning("llm time budget exhausted", extra={"model": model})
                    raise LLMTimeoutError()
                config = config.model_copy(update={"http_options": self._bounded_http_options(remaining)})
            try:
                return self._generate(model, contents, config)
            except (LLMUnavailableError, LLMRateLimitError):
                if index == len(models) - 1:
                    raise
                log.warning(
                    "llm model unavailable or out of quota, falling back",
                    extra={"model": model, "fallback_model": models[index + 1]},
                )
        raise AssertionError("unreachable")  # pragma: no cover

    def _bounded_http_options(self, remaining: float) -> types.HttpOptions:
        """Per-request options that keep this request (with its SDK retries) inside the time budget:
        the timeout never exceeds the remaining time, and SDK retries are dropped when they would not fit."""
        timeout = min(self._timeout_seconds, remaining)
        attempts = self._attempts if remaining >= self._attempts * timeout else 1
        return types.HttpOptions(
            timeout=max(1, int(timeout * 1000)),
            retry_options=types.HttpRetryOptions(
                attempts=attempts, http_status_codes=_TRANSIENT_STATUS_CODES
            ),
        )

    def _generate(self, model: str, contents: str | list, config: types.GenerateContentConfig) -> LLMResult:
        started = time.perf_counter()
        try:
            try:
                response = self._client.models.generate_content(model=model, contents=contents, config=config)
            except genai_errors.APIError as exc:
                # Some models (e.g. flash-lite) refuse a thinking budget they do not support with a plain 400
                # "invalid argument": the setting is only a latency tweak, so ask the same model again without it.
                if exc.code != 400 or config.thinking_config is None:
                    raise
                log.warning("model refused the thinking setting, retrying without it", extra={"model": model})
                config = config.model_copy(update={"thinking_config": None})
                response = self._client.models.generate_content(model=model, contents=contents, config=config)
        except genai_errors.APIError as exc:
            mapped = _map_api_error(exc)
            log.warning(
                "llm call failed",
                extra={"model": model, "status": exc.code, "error_code": mapped.code},
            )
            raise mapped from None
        except _TIMEOUT_EXC:
            log.warning("llm call timed out", extra={"model": model})
            raise LLMTimeoutError() from None
        except _CONNECT_EXC:
            log.warning("llm transport error", extra={"model": model})
            raise LLMUnavailableError() from None

        latency_ms = round((time.perf_counter() - started) * 1000)
        usage = getattr(response, "usage_metadata", None)
        log.info(
            "llm call ok",
            extra={
                "model": model,
                "latency_ms": latency_ms,
                "prompt_tokens": getattr(usage, "prompt_token_count", None),
                "output_tokens": getattr(usage, "candidates_token_count", None),
            },
        )
        return LLMResult(text=_extract_text(response), model=model)


def _extract_text(response: types.GenerateContentResponse) -> str:
    feedback = response.prompt_feedback
    if feedback is not None and feedback.block_reason:
        raise LLMBlockedError()
    candidates = response.candidates or []
    if candidates:
        reason = candidates[0].finish_reason
        reason_name = getattr(reason, "name", str(reason or ""))
        if reason_name in _BLOCKED_FINISH_REASONS:
            raise LLMBlockedError()
        if reason_name == "MAX_TOKENS":
            raise LLMInvalidOutputError("The AI provider's response was truncated.")
    try:
        text = response.text
    except ValueError:
        text = None
    if not text or not text.strip():
        raise LLMInvalidOutputError("The AI provider returned an empty response.")
    return text


def _map_api_error(exc: genai_errors.APIError) -> LLMError:
    code = exc.code or 0
    status = (exc.status or "").upper()
    message = (exc.message or "").lower()
    if code == 429 or status == "RESOURCE_EXHAUSTED":
        return LLMRateLimitError(retry_after=_retry_after_seconds(exc))
    if code in (401, 403) or "api key not valid" in message or "api_key_invalid" in message:
        return LLMAuthError()
    if code == 404:
        return LLMNotConfiguredError("The configured AI model is not available to this API key.")
    if code == 504 or status == "DEADLINE_EXCEEDED":
        return LLMTimeoutError()
    if code >= 500:
        return LLMUnavailableError()
    return LLMError()


def _retry_after_seconds(exc: genai_errors.APIError) -> int | None:
    """Gemini puts a RetryInfo detail like {"retryDelay": "31s"} on 429 responses."""
    details = []
    if isinstance(exc.details, dict):
        details = exc.details.get("error", {}).get("details", []) or []
    for detail in details:
        delay = detail.get("retryDelay") if isinstance(detail, dict) else None
        match = re.fullmatch(r"(\d+)(?:\.\d+)?s", delay or "")
        if match:
            return int(match.group(1)) + 1
    return None
