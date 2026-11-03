"""One audio file of the whole group discussion, for HR to listen back to.

Each student's browser (and HR's, while speaking) recorded its own microphone. Every recording is decoded, placed at its
own start time on one timeline (0 = the room locked, the same clock as the transcripts), mixed, and encoded once as
Opus in WebM (plays in every browser, about 15 MB an hour of speech). Parts of a track can be muted (a student's
private talk with HR is not part of the group's audio). Tracks are decoded one at a time into a temporary 16-bit file
and mixed in short blocks, so memory stays small even for a long discussion.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

RATE = 16_000  # speech; Opus encodes 16 kHz natively
BLOCK = RATE * 10  # mix 10 s at a time
MAX_SECONDS = 4 * 3600  # a group discussion is never this long: refuse instead of filling the disk


@dataclass
class Track:
    paths: list[Path]
    mime_type: str
    #: Where the recording starts on the session timeline (negative = started in the lobby, that part is dropped).
    offset_ms: int
    #: [start_ms, end_ms) on the session timeline where this track is silent.
    mute: list[tuple[int, int]] = field(default_factory=list)


class MixFailed(RuntimeError):
    pass


def _decode(track: Track, out_path: Path) -> int:
    """Joined chunks -> 16 kHz mono int16 samples written to out_path. Returns the sample count (0 = unreadable)."""
    import av  # PyAV, already installed for faster-whisper

    suffix = ".mp4" if "mp4" in track.mime_type else ".ogg" if "ogg" in track.mime_type else ".webm"
    fd, joined = tempfile.mkstemp(suffix=suffix, prefix="gd-mix-")
    count = 0
    try:
        with os.fdopen(fd, "wb") as f:
            for p in track.paths:
                f.write(p.read_bytes())
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
        with open(out_path, "wb") as raw:
            try:
                with av.open(joined) as container:
                    stream = next((s for s in container.streams if s.type == "audio"), None)
                    if stream is None:
                        return 0
                    for frame in container.decode(stream):
                        for f in resampler.resample(frame):
                            pcm = f.to_ndarray().reshape(-1).astype(np.int16, copy=False)
                            raw.write(pcm.tobytes())
                            count += len(pcm)
                    for f in resampler.resample(None):
                        pcm = f.to_ndarray().reshape(-1).astype(np.int16, copy=False)
                        raw.write(pcm.tobytes())
                        count += len(pcm)
            except (av.error.FFmpegError, ValueError, StopIteration):
                pass  # a recording cut off mid-chunk (tab closed): keep what decoded
        return count
    finally:
        try:
            os.remove(joined)
        except OSError:
            pass


def mix(tracks: list[Track], out_path: Path) -> dict:
    """Writes the mixed session to out_path (Opus / WebM). Returns { duration_ms, bytes }."""
    import av

    work = Path(tempfile.mkdtemp(prefix="gd-mix-"))
    decoded: list[tuple[Track, np.memmap, int]] = []  # track, samples, first sample on the timeline
    try:
        for i, t in enumerate(tracks):
            raw = work / f"{i}.pcm"
            n = _decode(t, raw)
            if n <= 0:
                continue
            start = round(t.offset_ms * RATE / 1000)
            if start + n <= 0:
                continue  # all of it before the room locked
            decoded.append((t, np.memmap(raw, dtype=np.int16, mode="r", shape=(n,)), start))
        if not decoded:
            raise MixFailed("no audio could be decoded from the recordings")

        total = max(start + len(s) for _, s, start in decoded)
        if total > MAX_SECONDS * RATE:
            raise MixFailed("the recordings are longer than a group discussion can be")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_out = out_path.with_suffix(".part")
        with av.open(str(tmp_out), "w", format="webm") as container:
            stream = container.add_stream("libopus", rate=RATE, layout="mono")
            stream.bit_rate = 32_000
            for b0 in range(0, total, BLOCK):
                b1 = min(b0 + BLOCK, total)
                acc = np.zeros(b1 - b0, dtype=np.float32)
                for t, samples, start in decoded:
                    lo, hi = max(b0, start), min(b1, start + len(samples))
                    if lo >= hi:
                        continue
                    part = samples[lo - start : hi - start].astype(np.float32) / 32768.0
                    for m0, m1 in t.mute:
                        z0, z1 = max(lo, round(m0 * RATE / 1000)), min(hi, round(m1 * RATE / 1000))
                        if z0 < z1:
                            part[z0 - lo : z1 - lo] = 0.0
                    acc[lo - b0 : hi - b0] += part
                np.clip(acc, -1.0, 1.0, out=acc)
                frame = av.AudioFrame.from_ndarray(acc.reshape(1, -1), format="flt", layout="mono")
                frame.sample_rate = RATE
                frame.pts = b0
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode(None):
                container.mux(packet)
        os.replace(tmp_out, out_path)
        return {"duration_ms": round(total * 1000 / RATE), "bytes": out_path.stat().st_size}
    finally:
        for _, samples, _ in decoded:
            samples._mmap.close()  # type: ignore[attr-defined]  # Windows: an open memmap blocks removing its file
        for p in work.glob("*"):
            try:
                p.unlink()
            except OSError:
                pass
        try:
            work.rmdir()
        except OSError:
            pass
