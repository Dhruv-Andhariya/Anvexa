"""The AI moderator: a LiveKit Agents worker (agent name "gd-moderator", dispatched by the ANVEXA API when a group's
room locks). It joins the group's room as its own tile, follows the live state in the room metadata, and speaks with
Piper (free, offline text-to-speech). The timeline itself lives in the API, so the GD keeps its timer and banner even
if the bot drops.

Run:  uv run python -m gd_agent moderator dev      (development, reload)
      uv run python -m gd_agent moderator start    (production)
LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET come from the repo-root .env.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import time

import numpy as np
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, JobProcess, WorkerOptions, cli

from .config import get_settings
from .script import LiveState, lines_for, silence_prompt

log = logging.getLogger("gd_agent.moderator")
AGENT_NAME = "gd-moderator"
FRAME_MS = 20


def load_voice():
    """The Piper voice (downloaded once, ~60 MB)."""
    from piper import PiperVoice
    from piper.download_voices import download_voice

    s = get_settings()
    s.piper_dir.mkdir(parents=True, exist_ok=True)
    model = s.piper_dir / f"{s.piper_voice}.onnx"
    if not model.exists():
        download_voice(s.piper_voice, s.piper_dir)
    return PiperVoice.load(model)


def prewarm(proc: JobProcess) -> None:
    proc.userdata["voice"] = load_voice()


class Speaker:
    """Speaks text into the room through one published audio track, one sentence after another."""

    def __init__(self, room: rtc.Room, voice) -> None:
        self.room = room
        self.voice = voice
        self.rate = int(voice.config.sample_rate)
        self.source = rtc.AudioSource(self.rate, 1)
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.speaking = False
        self.last_spoke = 0.0

    async def start(self) -> None:
        track = rtc.LocalAudioTrack.create_audio_track("moderator-voice", self.source)
        await self.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        asyncio.create_task(self._run())

    def say(self, text: str) -> None:
        self.queue.put_nowait(text)

    def clear(self) -> None:
        while not self.queue.empty():
            self.queue.get_nowait()

    async def _run(self) -> None:
        while True:
            text = await self.queue.get()
            self.speaking = True
            try:
                pcm = await asyncio.to_thread(self._synthesize, text)
                await self._play(pcm)
            except Exception as exc:  # noqa: BLE001 - a TTS hiccup must not stop the bot
                log.warning("could not speak: %s", type(exc).__name__)
            finally:
                self.speaking = False
                self.last_spoke = time.monotonic()

    def _synthesize(self, text: str) -> np.ndarray:
        chunks = [c.audio_int16_array for c in self.voice.synthesize(text)]
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)

    async def _play(self, pcm: np.ndarray) -> None:
        step = self.rate * FRAME_MS // 1000
        for i in range(0, len(pcm), step):
            part = pcm[i : i + step]
            if len(part) < step:
                part = np.pad(part, (0, step - len(part)))
            await self.source.capture_frame(rtc.AudioFrame(part.tobytes(), self.rate, 1, step))
        await self.source.wait_for_playout()


async def entrypoint(ctx: JobContext) -> None:
    # the moderator listens to nobody: LiveKit's own active-speaker detection says who talks
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    room = ctx.room
    try:
        await room.local_participant.set_name("AI Moderator")
    except Exception as exc:  # noqa: BLE001 - older servers / no permission: the page labels agents by kind anyway
        log.debug("name not set: %s", type(exc).__name__)
    voice = ctx.proc.userdata.get("voice") or await asyncio.to_thread(load_voice)
    speaker = Speaker(room, voice)
    await speaker.start()

    state: LiveState | None = None
    changes: asyncio.Queue[str] = asyncio.Queue()
    last_voice = time.monotonic()  # last time a student was speaking
    talk: dict[str, float] = {}  # identity -> seconds heard (for "we have not heard from ...")
    speaking_now: set[str] = set()
    prompts = 0
    last_prompt = time.monotonic()
    done = asyncio.Event()

    @room.on("room_metadata_changed")
    def _meta(_old: str, new: str) -> None:
        changes.put_nowait(new)

    @room.on("active_speakers_changed")
    def _speakers(speakers: list[rtc.Participant]) -> None:
        nonlocal last_voice
        speaking_now.clear()
        speaking_now.update(p.identity for p in speakers if p.identity.startswith("s:"))
        if speaking_now:
            last_voice = time.monotonic()

    async def follow() -> None:
        nonlocal state, last_voice, last_prompt
        await changes.put(room.metadata)
        while True:
            new = LiveState.parse(await changes.get())
            if not new:
                continue
            if state and new.phase != state.phase:
                speaker.clear()  # never read out an old phase's lines late
                last_voice = last_prompt = time.monotonic()
            for line in lines_for(state, new):
                speaker.say(line)
            state = new
            if new.phase == "ENDED":
                done.set()
                return

    async def watch_silence() -> None:
        nonlocal prompts, last_prompt
        tick = 1.0
        while not done.is_set():
            await asyncio.sleep(tick)
            for identity in speaking_now:
                talk[identity] = talk.get(identity, 0.0) + tick
            if not state or speaker.speaking:
                continue
            now = time.monotonic()
            quiet = [p.name.split(" ")[0] for p in sorted(room.remote_participants.values(), key=lambda p: talk.get(p.identity, 0.0)) if p.identity.startswith("s:") and p.name]
            line = silence_prompt(state, now - max(last_voice, speaker.last_spoke), now - last_prompt, quiet[:1] if talk else [], prompts)
            if line:
                prompts += 1
                last_prompt = now
                speaker.say(line)

    tasks = [asyncio.create_task(follow()), asyncio.create_task(watch_silence())]
    await done.wait()
    # let the goodbye finish, then leave
    while speaker.speaking or not speaker.queue.empty():
        await asyncio.sleep(0.5)
    for t in tasks:
        t.cancel()
    ctx.shutdown(reason="group discussion ended")


def _load_threshold() -> float:
    # Production mode refuses new groups above 75 % CPU ("worker is at full capacity"): on a busy laptop a group could
    # then start with NO moderator - no rules, no topic. The bot is light, so it takes every group unless this is set.
    raw = os.environ.get("GD_MODERATOR_LOAD_THRESHOLD", "").strip()
    try:
        return float(raw) if raw else math.inf
    except ValueError:
        return math.inf


def run() -> None:
    # one warm process is plenty for a few groups at a time and keeps a laptop's memory free (each holds the voice);
    # loading the voice takes well over the default 10 s on a busy laptop
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            agent_name=AGENT_NAME,
            num_idle_processes=1,
            initialize_process_timeout=90.0,
            load_threshold=_load_threshold(),
        )
    )
