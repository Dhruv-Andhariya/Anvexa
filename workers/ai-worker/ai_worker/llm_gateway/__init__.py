"""M31 LLM gateway: provider + model come from env, never from business logic."""
from ..config import Settings
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
from .prompts import PromptSpec, escape_data, load_prompt, parse_json_object
from .provider import Attachment, LLMProvider, LLMResult


def build_provider(settings: Settings) -> LLMProvider:
    if settings.llm_provider == "gemini":
        from .gemini import GeminiProvider

        return GeminiProvider(
            api_key=settings.gemini_api_key,
            model=settings.llm_model,
            timeout_seconds=settings.llm_timeout_seconds,
            transient_retries=settings.llm_transient_retries,
            fallback_models=settings.llm_fallback_models,
        )
    if not settings.llm_provider:
        raise LLMNotConfiguredError("LLM_PROVIDER is not set on the AI worker.")
    raise LLMNotConfiguredError(f"LLM_PROVIDER '{settings.llm_provider}' is not supported.")


__all__ = [
    "Attachment",
    "LLMAuthError",
    "LLMBlockedError",
    "LLMError",
    "LLMInvalidOutputError",
    "LLMNotConfiguredError",
    "LLMProvider",
    "LLMRateLimitError",
    "LLMResult",
    "LLMTimeoutError",
    "LLMUnavailableError",
    "PromptSpec",
    "build_provider",
    "escape_data",
    "load_prompt",
    "parse_json_object",
]
