"""Test doubles: a fake AI client and request builders. No network, no API key."""

from __future__ import annotations

import hashlib
import json

CODE = """def two_sum(nums, target):
    seen = {}
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i]
        seen[x] = i
    return []
"""


class FakeLLM:
    """Returns a prepared reply (dict -> JSON text, or raw text) or raises a prepared error. Records every call."""

    model = "fake-model"

    def __init__(self, reply=None, error: Exception | None = None):
        self.reply = reply
        self.error = error
        self.calls: list[dict] = []

    def generate_json(self, *, system, prompt, schema, temperature):
        self.calls.append({"system": system, "prompt": prompt, "schema": schema, "temperature": temperature})
        if self.error is not None:
            raise self.error
        return self.reply if isinstance(self.reply, str) else json.dumps(self.reply)


LIMITS = {"cpuMs": 4000, "wallMs": 5000, "memoryKb": 262144}
#: Trusted metadata that proves a failure was the candidate's (H6): an exception traced to the candidate's lines, and a
#: time limit reached on CPU time.
CANDIDATE_METADATA = {
    "runtime_error": {"exitCode": 1, "exceptionInCandidateCode": True},
    "time_limit": {"timeMs": 4000, "wallTimeMs": 5000},
}
_METADATA_KEYS = {"timeMs", "wallTimeMs", "exitCode", "signal", "runnerStatus", "exceptionInCandidateCode", "memoryKb"}


def request(
    code: str = CODE, *, verdict="failed", passed=3, total=4, cases=None, compile_output="", language="python",
    kind="SUBMIT", expected_total="auto", candidate_metadata=True, limits=LIMITS,
) -> dict:
    """A complete SUBMIT by default (expectedTotal = total). kind=None / expected_total=None leave the field out.

    candidate_metadata=True adds CANDIDATE_METADATA to runtime-error / time-limit cases that carry no metadata of their
    own, so tests about other features see verified candidate failures; H6 tests pass False to control it themselves.
    """
    if expected_total == "auto":
        expected_total = total
    if cases is None:
        cases = [
            {"caseId": f"c{i}", "hidden": i > 1, "category": "normal", "status": "passed" if i <= passed else "wrong_answer"}
            for i in range(1, total + 1)
        ]
    if candidate_metadata:
        cases = [
            {**c, **CANDIDATE_METADATA[c["status"]]} if c["status"] in CANDIDATE_METADATA and not _METADATA_KEYS & set(c) else c
            for c in cases
        ]
    execution = {"verdict": verdict, "passed": passed, "total": total, "cases": cases, "compileOutput": compile_output}
    if limits is not None:
        execution["limits"] = limits
    if kind is not None:
        execution["kind"] = kind
    if expected_total is not None:
        execution["expectedTotal"] = expected_total
    return {
        "requestId": "req-0001-abcd",
        "problem": {
            "questionId": "q-1",
            "title": "Two Sum",
            "statement": "Return the indices of the two numbers that add up to target.",
            "inputFormat": "n, then n integers, then target",
            "outputFormat": "two indices",
            "constraints": ["2 <= n <= 10^5"],
        },
        "submission": {"language": language, "code": code, "codeHash": hashlib.sha256(code.encode()).hexdigest()},
        "execution": execution,
    }


def defect(criterion="LOGIC_SLIP", line=4, quote="if target - x in seen:", description="The membership check misses one case.", evidence=None):
    """One AI defect. The AI names a rubric criterion only; severity and kind are derived by the worker."""
    if evidence is None:
        evidence = [{"line_start": line, "line_end": line, "quote": quote}]
    return {"criterion": criterion, "description": description, "evidence": evidence}


def assessment(approach="CORRECT", defects=None, band=75, reasoning="One minor logic slip in the lookup; the approach is sound."):
    return {"approach": approach, "defects": [defect()] if defects is None else defects, "proposed_band": band, "reasoning": reasoning}
