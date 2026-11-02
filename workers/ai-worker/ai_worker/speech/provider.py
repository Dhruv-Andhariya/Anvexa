from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SpeechResult:
    data: bytes  # a complete, playable audio file
    mime_type: str  # always "audio/wav" today
    model: str


class SpeechProvider(Protocol):
    """Text-to-speech for the AI screening round (M12). Another vendor plugs in here without touching the API,
    the careers site or the conversation flow. `deadline` is a time.monotonic() value bounding the call."""

    def synthesize(self, text: str, *, deadline: float | None = None) -> SpeechResult: ...
