"""Text-to-speech for the M12 AI screening round. Provider + model + voice come from env, never from the flow."""
from ..config import Settings
from ..llm_gateway import LLMNotConfiguredError
from .provider import SpeechProvider, SpeechResult


def build_speech_provider(settings: Settings) -> SpeechProvider:
    if settings.llm_provider == "gemini":
        from .gemini_tts import GeminiSpeechProvider

        return GeminiSpeechProvider(
            api_key=settings.gemini_api_key,
            model=settings.screening_tts_model,
            voice=settings.screening_tts_voice,
            timeout_seconds=settings.screening_speech_budget_seconds,
            fallback_models=settings.screening_tts_fallback_models,
        )
    if not settings.llm_provider:
        raise LLMNotConfiguredError("LLM_PROVIDER is not set on the AI worker.")
    raise LLMNotConfiguredError(f"Text-to-speech is not available for LLM_PROVIDER '{settings.llm_provider}'.")


__all__ = ["SpeechProvider", "SpeechResult", "build_speech_provider"]
