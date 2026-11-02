from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel


@dataclass(frozen=True)
class LLMResult:
    text: str  # raw JSON text from the model; callers validate it
    model: str


@dataclass(frozen=True)
class Attachment:
    """A file the model reads together with the prompt (e.g. a scanned resume PDF)."""

    data: bytes
    mime_type: str


class LLMProvider(Protocol):
    """One door for all AI calls (doc 13.1). Callers ask for JSON matching `schema`.
    `deadline` (a time.monotonic() value) bounds the whole call, including retries and fallbacks.
    `attachments` are sent before the prompt text. `thinking_budget` (tokens, 0 = off) is only for latency-critical
    calls such as live screening turns; None leaves the model's default."""

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
    ) -> LLMResult: ...
