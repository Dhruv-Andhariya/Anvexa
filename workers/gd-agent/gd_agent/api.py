"""HTTP side of the GD worker, called by the HireFlow API after a group discussion:

  POST /gd/transcribe  { chunk_paths, mime_type }  -> { language, segments: [{ start, end, text }] }  (seconds)
  POST /gd/evaluate    { student_id, ..., asked_by_hr } -> { result: <rubric JSON>, model }
  POST /gd/mix         { tracks: [{ chunk_paths, mime_type, offset_ms, mute }], out_path } -> { duration_ms, bytes }

Runs on the same machine as the API (it reads the audio files the API stored). Local only; when GD_WORKER_SECRET is
set the API must send it in x-worker-secret.
"""

from __future__ import annotations

import hmac
import logging
import threading
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import get_settings
from .evaluate import EvaluateRequest, EvaluationFailed, evaluate, gemini_llm
from .mix import MixFailed, Track, mix
from .transcribe import UnsafePath, safe_chunk_paths, transcribe

log = logging.getLogger("gd_agent.api")
app = FastAPI(title="HireFlow GD worker", version="0.1.0")
# one transcription at a time: Whisper on a laptop CPU uses all cores and a lot of memory
_whisper_lock = threading.Lock()


class TranscribeRequest(BaseModel):
    chunk_paths: list[str] = Field(max_length=5000)
    mime_type: str = Field(max_length=60)


class MixTrack(BaseModel):
    chunk_paths: list[str] = Field(max_length=5000)
    mime_type: str = Field(max_length=60)
    offset_ms: int
    mute: list[tuple[int, int]] = Field(default_factory=list, max_length=500)


class MixRequest(BaseModel):
    tracks: list[MixTrack] = Field(min_length=1, max_length=200)
    out_path: str = Field(max_length=1000)


def _check(secret: str | None) -> None:
    expected = get_settings().worker_secret
    if expected and not hmac.compare_digest(expected, secret or ""):
        raise HTTPException(status_code=401, detail="bad worker secret")


@app.get("/health")
def health() -> dict:
    s = get_settings()
    return {"status": "ok", "whisper_model": s.whisper_model, "llm": bool(s.gemini_api_key)}


@app.post("/gd/transcribe")
def transcribe_route(req: TranscribeRequest, x_worker_secret: str | None = Header(default=None)) -> dict:
    _check(x_worker_secret)
    settings = get_settings()
    try:
        paths = safe_chunk_paths(req.chunk_paths, settings.storage_dir)
    except UnsafePath as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    with _whisper_lock:
        try:
            language, segments = transcribe(paths, req.mime_type, settings)
        except Exception as exc:  # noqa: BLE001 - a broken / empty recording must not stop the group
            log.warning("transcription failed: %s", type(exc).__name__)
            return {"language": None, "segments": [], "error": type(exc).__name__}
    return {"language": language, "segments": [s.__dict__ for s in segments]}


@app.post("/gd/evaluate")
def evaluate_route(req: EvaluateRequest, x_worker_secret: str | None = Header(default=None)) -> dict:
    _check(x_worker_secret)
    try:
        llm, model = gemini_llm(get_settings())
        result = evaluate(req, llm)
    except EvaluationFailed as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"result": result.model_dump(), "model": model()}


@app.post("/gd/mix")
def mix_route(req: MixRequest, x_worker_secret: str | None = Header(default=None)) -> dict:
    _check(x_worker_secret)
    settings = get_settings()
    root = settings.storage_dir.resolve()
    out = Path(req.out_path).resolve()
    # only "<group folder>/session.webm" inside the storage folder may be written
    if out.name != "session.webm" or root not in out.parents:
        raise HTTPException(status_code=400, detail="not a GD session file under the storage folder")
    try:
        tracks = [Track(safe_chunk_paths(t.chunk_paths, settings.storage_dir), t.mime_type, t.offset_ms, list(t.mute)) for t in req.tracks]
    except UnsafePath as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    with _whisper_lock:  # same CPU budget as transcription
        try:
            return mix(tracks, out)
        except MixFailed as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
