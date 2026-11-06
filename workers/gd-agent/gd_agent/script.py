"""What the AI moderator says, as pure functions (no audio, no LiveKit): tested on their own.

The ANVEXA API owns the timeline and pushes it as the room metadata (GdLiveState). The bot compares the previous and
the new state and speaks: greeting + rules, the topic, the start of the discussion, each student's summary turn, the
hand-over to HR, the goodbye. During the discussion it only speaks after a silence, never while HR is speaking.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class LiveState:
    phase: str
    topic: str | None
    paused: bool
    hr_speaking: bool
    current_speaker: str | None  # first name
    summary_order: tuple[str, ...]
    plan: dict[str, int]  # phase -> seconds
    silence_prompt_seconds: int
    with_hr: tuple[str, ...] = field(default_factory=tuple)

    @staticmethod
    def parse(metadata: str | None) -> LiveState | None:
        if not metadata:
            return None
        try:
            d: dict[str, Any] = json.loads(metadata)
        except ValueError:
            return None
        if d.get("v") != 1 or not isinstance(d.get("phase"), str):
            return None
        speaker = d.get("currentSpeaker") or None
        return LiveState(
            phase=d["phase"],
            topic=d.get("topic") or None,
            paused=bool(d.get("pausedAt")),
            hr_speaking=bool(d.get("hrSpeaking")),
            current_speaker=speaker.get("name") if isinstance(speaker, dict) else None,
            summary_order=tuple(s.get("name", "") for s in d.get("summaryOrder") or [] if isinstance(s, dict)),
            plan={p["phase"]: int(p["seconds"]) for p in d.get("plan") or [] if isinstance(p, dict) and "phase" in p},
            silence_prompt_seconds=int(d.get("silencePromptSeconds") or 20),
            with_hr=tuple(d.get("withHr") or []),
        )


def _duration(seconds: int) -> str:
    if seconds % 60 == 0:
        m = seconds // 60
        return f"{m} minute{'s' if m != 1 else ''}"
    if seconds > 60:
        return f"{seconds // 60} minutes and {seconds % 60} seconds"
    return f"{seconds} seconds"


def lines_for(prev: LiveState | None, new: LiveState) -> list[str]:
    """What to say when the state changes from `prev` to `new` (empty list = stay quiet)."""
    out: list[str] = []
    if prev is None or prev.phase != new.phase:
        p = new.plan
        if new.phase == "INTRO":
            out.append(
                "Hello everyone, and welcome to this group discussion. I am your AI moderator. "
                "Here are the rules. Please keep your camera and microphone on throughout. "
                "Speak one at a time, listen to each other, and build on each other's points. Be respectful, and do not "
                "interrupt. In a moment I will announce the topic, and you will get "
                f"{_duration(p.get('THINKING', 120))} to think. Then the discussion runs for "
                f"{_duration(p.get('DISCUSSION', 900))}. At the end, each of you will give a short summary."
            )
        elif new.phase == "THINKING" and new.topic:
            out.append(
                f"Here is your topic. {new.topic}. I repeat: {new.topic}. "
                f"You now have {_duration(p.get('THINKING', 120))} to think and note down your points. "
                "The topic is shown at the top of your screen."
            )
        elif new.phase == "DISCUSSION":
            if prev is None and new.topic:
                # the moderator joined late: the group still hears its topic once
                out.append(f"Hello everyone, I am your AI moderator. Your topic is: {new.topic}. The discussion is in progress, please continue.")
            else:
                out.append(f"Thinking time is over. The discussion starts now, and you have {_duration(p.get('DISCUSSION', 900))}. Anyone may begin.")
        elif new.phase == "SUMMARY":
            per = (p.get("SUMMARY", 60) // max(1, len(new.summary_order))) if new.summary_order else 60
            first = new.current_speaker or (new.summary_order[0] if new.summary_order else None)
            out.append(
                "Thank you, the discussion time is over. Now it is time for the summary round. "
                f"I will call each of you by name, and you will have {_duration(per)} to summarise the discussion."
            )
            if first:
                out.append(f"{first}, please begin your summary.")
            return out
        elif new.phase == "HR_QUESTIONS":
            out.append("Thank you all for your summaries. Now the HR team would like to ask a few questions. Over to HR.")
        elif new.phase == "CLOSE":
            out.append(
                "That brings us to the end of this group discussion. Thank you all for taking part. "
                "The hiring team will share the results with you by email. Goodbye, and all the best."
            )
        return out
    # the topic reached the room a moment after thinking time began: announce it now (every group hears its topic)
    if new.phase == "THINKING" and new.topic and not prev.topic:
        return lines_for(None, new)
    if new.phase == "SUMMARY" and new.current_speaker and prev.current_speaker != new.current_speaker:
        out.append(f"Thank you. {new.current_speaker}, please give your summary now.")
    elif new.phase == "HR_QUESTIONS" and prev.phase == "HR_QUESTIONS":
        pass  # the bot stays silent while HR asks questions
    return out


SILENCE_PROMPTS = (
    "Let's keep the discussion going. Who would like to share the next point?",
    "Does anyone want to add a different perspective on the topic?",
    "Feel free to build on what was said earlier, or bring in a new angle.",
)


def silence_prompt(state: LiveState, silent_seconds: float, since_last_prompt: float, quiet_names: list[str], n: int) -> str | None:
    """A gentle prompt after `silencePromptSeconds` of silence in the discussion; never while paused or HR speaks."""
    if state.phase != "DISCUSSION" or state.paused or state.hr_speaking:
        return None
    limit = state.silence_prompt_seconds
    if silent_seconds < limit or since_last_prompt < limit:
        return None
    if quiet_names and n % 2 == 1:
        return f"We have not heard much from {quiet_names[0]} yet. {quiet_names[0]}, would you like to share your view?"
    return SILENCE_PROMPTS[n % len(SILENCE_PROMPTS)]
