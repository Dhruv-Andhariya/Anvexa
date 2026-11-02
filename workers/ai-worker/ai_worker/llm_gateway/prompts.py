"""Prompt registry: prompts live in <repo>/prompts/*.yaml with a version (doc 13.1).
Templates use string.Template ($name) so JSON braces in values are safe."""
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from string import Template

import yaml

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


@dataclass(frozen=True)
class PromptSpec:
    task: str
    version: str
    temperature: float
    system: str
    user_template: str

    def render(self, **values: str) -> str:
        return Template(self.user_template).substitute(**values)


@lru_cache(maxsize=32)
def load_prompt(path: Path) -> PromptSpec:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return PromptSpec(
        task=str(data["task"]),
        version=str(data["version"]),
        temperature=float(data.get("temperature", 0.7)),
        system=str(data["system"]).strip(),
        user_template=str(data["user"]).strip(),
    )


def escape_data(text: str) -> str:
    """User text must not be able to close the <...> data tags of a prompt (prompt-injection hardening)."""
    return text.replace("<", "\\u003c").replace(">", "\\u003e")


def parse_json_object(text: str) -> dict:
    """The model's JSON answer as a dict. Structured output should never be fenced, but be tolerant."""
    match = _FENCE.match(text)
    if match:
        text = match.group(1)
    data = json.loads(text)
    if not isinstance(data, dict):
        raise TypeError("model output is not a JSON object")
    return data
