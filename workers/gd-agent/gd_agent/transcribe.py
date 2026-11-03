"""Whisper (faster-whisper, local, free) for one GD recording.

The API stores a recording as numbered chunk files; joined in order they are the browser's original WebM / MP4 file,
which faster-whisper decodes itself (PyAV). Only files under GD_STORAGE_DIR are ever read.
"""

from __future__ import annotations

import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

from .config import Settings

_model = None
_model_lock = threading.Lock()


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str


class UnsafePath(ValueError):
    pass


def safe_chunk_paths(paths: list[str], storage_dir: Path) -> list[Path]:
    """Every path must be a *.chunk file inside the storage folder (the API sends absolute paths)."""
    root = storage_dir.resolve()
    out: list[Path] = []
    for raw in paths:
        p = Path(raw).resolve()
        if p.suffix != ".chunk" or (root not in p.parents):
            raise UnsafePath(f"not a GD chunk under the storage folder: {p.name}")
        out.append(p)
    return out


def _whisper(settings: Settings):
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel  # heavy import, first use only

            _model = WhisperModel(settings.whisper_model, device="cpu", compute_type="int8")
        return _model


def transcribe(paths: list[Path], mime_type: str, settings: Settings) -> tuple[str | None, list[Segment]]:
    if not paths:
        return None, []
    suffix = ".mp4" if "mp4" in mime_type else ".ogg" if "ogg" in mime_type else ".webm"
    fd, joined = tempfile.mkstemp(suffix=suffix, prefix="gd-")
    try:
        with os.fdopen(fd, "wb") as out:
            for p in paths:
                out.write(p.read_bytes())
        segments, info = _whisper(settings).transcribe(
            joined,
            language=settings.whisper_language,
            vad_filter=True,  # silence (other students talking, muted mic) is skipped
            beam_size=1,
            condition_on_previous_text=False,
        )
        result = [Segment(round(s.start, 2), round(s.end, 2), s.text.strip()) for s in segments if s.text.strip()]
        return getattr(info, "language", None), result
    finally:
        try:
            os.remove(joined)
        except OSError:
            pass
