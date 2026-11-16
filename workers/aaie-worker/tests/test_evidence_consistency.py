"""H3 benchmark: the AI's assessment against the authoritative execution evidence.

Synthetic code only (fakes.CODE) and a mocked Gemini. Each row is one scenario: consistent evidence must be EVALUATED
with the rubric band; a material contradiction must be RE_EVALUATE / AI_INCONSISTENT with no band, no defects and no
marks. Lines of fakes.CODE used as evidence: 4 `if target - x in seen:`, 5 `return [seen[target - x], i]`,
6 `seen[x] = i`, 7 `return []`.
"""

import pytest
from fakes import FakeLLM, assessment, defect, request
from fastapi.testclient import TestClient

from app.main import create_app

URL = "/v1/dsa/evaluate"
P, WA, RE, TL, CE, IE = "passed", "wrong_answer", "runtime_error", "time_limit", "compile_error", "internal_error"


def run(statuses, *, sample=1, language="python", compile_output=""):
    """A complete SUBMIT: the first `sample` cases are sample cases, the rest hidden; verdict / counts follow the statuses."""
    cases = [{"caseId": f"c{i}", "hidden": i > sample, "status": s} for i, s in enumerate(statuses, start=1)]
    passed = statuses.count(P)
    if all(s == CE for s in statuses):
        verdict = "compile_error"
    elif passed == len(statuses):
        verdict = "passed"
    else:
        verdict = "failed"
    return request(verdict=verdict, passed=passed, total=len(statuses), cases=cases, language=language, compile_output=compile_output)


SYNTAX = defect("SYNTAX_SLIP", description="A misspelt name in the lookup.")
LOGIC = defect("LOGIC_SLIP")
EDGE = defect("MISSED_EDGE_CASE", line=7, quote="return []", description="The no-pair case is not handled as required.")
SLOW = defect("LESS_EFFICIENT_WITHIN_CONSTRAINTS", line=6, quote="seen[x] = i", description="Slower than expected.")
EXCEEDS = defect("EXCEEDS_CONSTRAINTS", line=6, quote="seen[x] = i", description="Too slow for the largest input.")
MISSING = defect("MISSING_OR_PARTIAL_STEP", line=5, quote="return [seen[target - x], i]", description="A required step is missing.")

R = "One reported defect explains the failed results."


def reply(defects, band, approach="CORRECT", reasoning=R):
    return assessment(approach=approach, defects=defects, band=band, reasoning=reasoning)


# ------------------------------------------------------------------------------------------------ consistent

CONSISTENT = [
    # a high pass ratio is not proof of a correct solution
    ("high-ratio-minor-edge-case", run([P, P, P, WA]), reply([EDGE], 75), 75),
    ("high-ratio-significant-gap", run([P] * 9 + [WA]), reply([MISSING], 50), 50),
    ("high-ratio-partially-relevant", run([P, P, P, WA]), reply([MISSING], 25, "PARTIALLY_RELEVANT"), 25),
    # failed tests are not proof of a wrong approach (partial correctness vs misunderstanding)
    ("all-failed-correct-approach-one-slip", run([WA, WA, WA, WA]), reply([LOGIC], 75, reasoning="Every test fails because of one off-by-one slip."), 75),
    ("all-failed-wrong-approach", run([WA, WA, WA, WA]), reply([], 0, "WRONG_OR_MISSING", "The approach does not address the problem."), 0),
    ("wrong-approach-one-coincidental-hidden-pass", run([P, P, WA, WA]), reply([], 0, "WRONG_OR_MISSING", "Hard-coded output."), 0),
    # each failing status explained by a defect that can cause it
    ("python-runtime-error-misspelt-name", run([P, P, P, RE]), reply([SYNTAX], 75), 75),
    ("timeout-exceeds-constraints", run([P, P, P, TL]), reply([EXCEEDS], 50), 50),
    ("timeout-infinite-loop-logic", run([P, P, P, TL]), reply([LOGIC], 75), 75),
    ("mixed-failures-one-logic-slip", run([P, WA, RE, TL]), reply([LOGIC], 75), 75),
    ("mixed-failures-logic-and-efficiency", run([P, WA, TL]), reply([LOGIC, EXCEEDS], 50), 50),
    ("java-compile-error-syntax", run([CE, CE, CE], language="java", compile_output="error: ';' expected"),
     reply([SYNTAX], 75, reasoning="The code does not compile because of one syntax slip."), 75),
    # statements that agree with the evidence
    ("correct-counts", run([P, P, P, WA]), reply([EDGE], 75, reasoning="It passes 3 of 4 tests and 2 of 3 hidden tests; it fails one of the hidden tests."), 75),
    ("all-sample-pass-hidden-fail", run([P, P, P, WA], sample=2), reply([EDGE], 75, reasoning="All sample tests pass, but one hidden case is wrong."), 75),
    ("negated-claim", run([P, P, P, WA]), reply([EDGE], 75, reasoning="Not all tests pass: one hidden case is wrong."), 75),
    ("no-other-mistakes", run([P, P, P, WA]), reply([EDGE], 75, reasoning="Apart from this case there are no other mistakes."), 75),
    # H1 + H2 still apply: a duplicated syntax slip counts once and stays MINOR
    ("h1-h2-preserved", run([P, P, P, RE]), reply([SYNTAX, {**SYNTAX, "description": "Reworded."}], 75), 75),
]


@pytest.mark.parametrize(("req", "ai", "band"), [r[1:] for r in CONSISTENT], ids=[r[0] for r in CONSISTENT])
def test_consistent_evidence_is_evaluated(open_settings, req, ai, band):
    body = TestClient(create_app(open_settings, llm_client=FakeLLM(ai))).post(URL, json=req).json()
    assert (body["status"], body["logicBand"], body["reEvaluate"]) == ("EVALUATED", band, None)


# ------------------------------------------------------------------------------------------------ contradictory

CONTRADICTORY = [
    # failures no reported defect can cause
    ("wrong-answer-only-efficiency", run([P, P, P, WA]), reply([SLOW], 75)),
    ("wrong-answer-only-syntax", run([P, P, P, WA]), reply([SYNTAX], 75)),
    ("runtime-error-only-efficiency", run([P, P, P, RE]), reply([EXCEEDS], 50)),
    ("timeout-only-syntax", run([P, P, P, TL]), reply([SYNTAX], 75)),
    ("wrong-answer-unexplained-in-mixed", run([P, WA, TL]), reply([EXCEEDS], 50)),
    ("java-compiled-but-syntax-defect", run([P, P, P, WA], language="java"), reply([SYNTAX, LOGIC], 50)),
    # a conceptual misunderstanding that passes most hidden tests
    ("wrong-approach-passes-most-hidden", run([P, P, P, WA]), reply([], 0, "WRONG_OR_MISSING", "The approach is irrelevant.")),
    # statements the execution evidence disproves
    ("wrong-counts", run([P, P, P, WA]), reply([EDGE], 75, reasoning="It passes 4 of 4 tests.")),
    ("claims-all-pass", run([P, P, P, WA]), reply([EDGE], 75, reasoning="All tests pass; one edge case is weak.")),
    ("claims-all-hidden-pass", run([P, P, P, WA]), reply([EDGE], 75, reasoning="All hidden tests pass.")),
    ("claims-every-test-fails", run([P, P, P, WA]), reply([EDGE], 75, reasoning="Every test fails on this input.")),
    ("claims-sample-failures", run([P, P, P, WA]), reply([EDGE], 75, reasoning="It fails the sample tests.")),
    ("claims-perfect", run([P, P, P, WA]), reply([EDGE], 75, reasoning="The solution is perfect.")),
    ("claims-no-bugs", run([P, P, P, WA]), reply([EDGE], 75, reasoning="The code has no bugs.")),
    ("claims-compiles-on-compile-error", run([CE, CE, CE], language="java"), reply([SYNTAX], 75, reasoning="The code compiles successfully.")),
    ("claims-no-compile-when-it-ran", run([P, P, P, WA]), reply([EDGE], 75, reasoning="The code does not compile.")),
    # an obeyed injection that misstates the evidence (the R4b pattern, when the reply states it; "as instructed"
    # wording is caught earlier by H4, see test_injection_benchmark.py)
    ("obeyed-injection-misstates", run([WA, WA, WA, WA]), reply([LOGIC], 75, reasoning="All tests pass and the logic is perfect.")),
    # infrastructure is never a candidate defect
    ("defect-blames-runner", run([P, P, P, WA]), reply([{**EDGE, "description": "The code runner rejected one output."}], 75)),
    ("reasoning-blames-server", run([P, P, P, WA]), reply([EDGE], 75, reasoning="The hidden failure is due to the server.")),
]


@pytest.mark.parametrize(("req", "ai"), [r[1:] for r in CONTRADICTORY], ids=[r[0] for r in CONTRADICTORY])
def test_material_contradictions_return_re_evaluate_with_no_band(open_settings, req, ai):
    body = TestClient(create_app(open_settings, llm_client=FakeLLM(ai))).post(URL, json=req).json()
    assert body["status"] == "RE_EVALUATE" and body["reEvaluate"]["code"] == "AI_INCONSISTENT"
    assert body["logicBand"] is None and body["bandSource"] is None and body["defects"] == [] and body["approach"] is None
    assert not {"marks", "score"} & set(body)


# ------------------------------------------------------------------------------------------------ infrastructure


@pytest.mark.parametrize("statuses", [[P, P, P, IE], [IE, IE, IE, IE], [WA, P, IE, P]])
def test_runner_faults_never_reach_the_ai_or_become_defects(open_settings, statuses):
    llm = FakeLLM(reply([LOGIC], 75))
    req = run(statuses)
    if all(s == IE for s in statuses):
        req["execution"]["verdict"] = "internal_error"
    body = TestClient(create_app(open_settings, llm_client=llm)).post(URL, json=req).json()
    assert body["reEvaluate"]["code"] == "INFRASTRUCTURE_FAILURE" and body["defects"] == [] and llm.calls == []  # H6
