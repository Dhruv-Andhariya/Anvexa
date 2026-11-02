"""M10 scanned-resume fallback: a PDF with no text layer (a scan, or a phone photo saved as PDF) is sent to the
model, which reads the page images and writes the text out. That text then goes through the normal screening,
so a scanned resume is read and scored exactly like a digital one (same prompt, same formula, same skill check).
Nothing readable -> ResumeHasNoTextError -> HR reviews it by hand, as before."""
import logging
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from ..llm_gateway import (
    Attachment,
    LLMInvalidOutputError,
    LLMProvider,
    PromptSpec,
    parse_json_object,
)
from .extract import PDF, ResumeHasNoTextError, first_pages, usable_text

log = logging.getLogger("ai_worker.parsing")

PROMPT_FILE = "resume_transcribe.v1.yaml"
MAX_ATTEMPTS = 2  # one retry on invalid output, no more (protects quota)


class ResumeTranscript(BaseModel):  # what the model fills in (Gemini structured output)
    readable: bool
    text: str = ""


@dataclass(frozen=True)
class Transcript:
    text: str
    model: str
    prompt_version: str


def transcribe_resume(
    data: bytes, provider: LLMProvider, prompt: PromptSpec, *, deadline: float | None = None
) -> Transcript:
    attachment = Attachment(data=first_pages(data), mime_type=PDF)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        out = provider.generate_json(
            system=prompt.system,
            prompt=prompt.render(),
            schema=ResumeTranscript,
            temperature=prompt.temperature,
            deadline=deadline,
            attachments=[attachment],
        )
        try:
            transcript = ResumeTranscript.model_validate(parse_json_object(out.text))
        except (ValueError, TypeError, ValidationError) as exc:
            # failure class only - never the model output (it is the resume content)
            log.warning("resume transcript invalid", extra={"attempt": attempt, "error_type": type(exc).__name__})
            continue
        if not transcript.readable:
            raise ResumeHasNoTextError(
                "The scanned resume could not be read (it may be blurry or not a resume). HR should review it by hand."
            )
        text = usable_text(transcript.text)  # same normalising, minimum and cut as a digital resume
        log.info("scanned resume transcribed", extra={"model": out.model, "chars": len(text)})
        return Transcript(text=text, model=out.model, prompt_version=prompt.version)
    raise LLMInvalidOutputError()
