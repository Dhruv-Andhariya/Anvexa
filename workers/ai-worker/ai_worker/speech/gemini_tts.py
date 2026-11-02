"""Gemini text-to-speech (speech generation). Same safety rules as the LLM provider: failures become a safe
LLMError, and only metadata is logged (model, latency, size) - never the text."""
import io
import logging
import re
import time
import wave

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from ..llm_gateway import (
    LLMInvalidOutputError,
    LLMNotConfiguredError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUnavailableError,
)
from ..llm_gateway.gemini import _CONNECT_EXC, _TIMEOUT_EXC, _map_api_error
from .provider import SpeechResult

log = logging.getLogger("ai_worker.speech")

# Raw PCM from the model is 16-bit mono; the rate is in the mime type ("audio/L16;codec=pcm;rate=24000").
_DEFAULT_RATE = 24000


class GeminiSpeechProvider:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        voice: str,
        timeout_seconds: float = 20.0,
        fallback_models: tuple[str, ...] = (),
        client: genai.Client | None = None,
    ):
        if not api_key:
            raise LLMNotConfiguredError("GEMINI_API_KEY is not set on the AI worker.")
        if not model:
            raise LLMNotConfiguredError("SCREENING_TTS_MODEL is not set on the AI worker.")
        self.model = model
        self.voice = voice
        # Tried in order when the previous model is out of quota (429 - TTS quotas are per model and small on the free
        # tier) or overloaded (5xx). Same rule as the LLM gateway's LLM_FALLBACK_MODELS.
        self.fallback_models = tuple(m for m in fallback_models if m and m != model)
        self._timeout_seconds = timeout_seconds
        self._client = client or genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=int(timeout_seconds * 1000)))

    def synthesize(self, text: str, *, deadline: float | None = None) -> SpeechResult:
        models = (self.model, *self.fallback_models)
        for index, model in enumerate(models):
            try:
                return self._synthesize(model, text, deadline)
            except (LLMRateLimitError, LLMUnavailableError):
                if index == len(models) - 1:
                    raise
                log.warning("tts model out of quota or unavailable, falling back", extra={"model": model, "fallback_model": models[index + 1]})
        raise AssertionError("unreachable")  # pragma: no cover

    def _synthesize(self, model: str, text: str, deadline: float | None) -> SpeechResult:
        timeout = self._timeout_seconds
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise LLMTimeoutError()
        config = types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=self.voice))
            ),
            http_options=types.HttpOptions(timeout=max(1, int(timeout * 1000))),
        )
        started = time.perf_counter()
        try:
            response = self._client.models.generate_content(model=model, contents=text, config=config)
        except genai_errors.APIError as exc:
            mapped = _map_api_error(exc)
            log.warning("tts call failed", extra={"model": model, "status": exc.code, "error_code": mapped.code})
            raise mapped from None
        except _TIMEOUT_EXC:
            log.warning("tts call timed out", extra={"model": model})
            raise LLMTimeoutError() from None
        except _CONNECT_EXC:
            log.warning("tts transport error", extra={"model": model})
            raise LLMUnavailableError() from None

        blob = _audio_part(response)
        audio = to_wav(blob.data, blob.mime_type or "")
        log.info(
            "tts call ok",
            extra={"model": model, "latency_ms": round((time.perf_counter() - started) * 1000), "bytes": len(audio)},
        )
        return SpeechResult(data=audio, mime_type="audio/wav", model=model)


def _audio_part(response: types.GenerateContentResponse) -> types.Blob:
    for candidate in response.candidates or []:
        for part in (candidate.content.parts if candidate.content else None) or []:
            if part.inline_data and part.inline_data.data:
                return part.inline_data
    raise LLMInvalidOutputError("The speech provider returned no audio.")


def to_wav(data: bytes, mime_type: str) -> bytes:
    """Newer models already return a WAV file; older ones return headerless 16-bit PCM, which gets a WAV header."""
    if data[:4] == b"RIFF":
        return data
    match = re.search(r"rate=(\d+)", mime_type)
    rate = int(match.group(1)) if match else _DEFAULT_RATE
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(data)
    return out.getvalue()
