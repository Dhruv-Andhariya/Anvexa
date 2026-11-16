"""H7 benchmark (D-H7 Option A, approved): efficiency is established by execution, never by the AI alone.

Synthetic code, Gemini mocked. Limits: CPU 4000 ms (a verified candidate timeout has CPU time >= 90 % of it).
"""

import hashlib

import pytest
from fakes import CODE, FakeLLM, assessment, defect, request
from fastapi.testclient import TestClient

from app.main import create_app

URL = "/v1/dsa/evaluate"

# Two Sum, O(n^2): every pair is tried
QUADRATIC = """def two_sum(nums, target):
    for i in range(len(nums)):
        for j in range(i + 1, len(nums)):
            if nums[i] + nums[j] == target:
                return [i, j]
    return []
"""
# Fibonacci, O(2^n) recursion
EXPONENTIAL = """def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
"""

VERIFIED_TL = {"status": "time_limit", "timeMs": 3950, "wallTimeMs": 5000}
WALL_ONLY_TL = {"status": "time_limit", "timeMs": 200, "wallTimeMs": 5000}
WA = {"status": "wrong_answer"}
P = {"status": "passed"}


def case(i, outcome, category="normal"):
    return {"caseId": f"c{i}", "hidden": i > 1, "category": category, **outcome}


def submit(code, outcomes, **execution):
    """A complete SUBMIT; outcomes = [(outcome, category), ...]; c1 is the sample case."""
    cases = [case(i, o, cat) for i, (o, cat) in enumerate(outcomes, start=1)]
    passed = sum(c["status"] == "passed" for c in cases)
    body = request(code, verdict="passed" if passed == len(cases) else "failed", passed=passed, total=len(cases),
                   cases=cases, candidate_metadata=False)
    body["execution"].update(execution)
    return body


def post(open_settings, body, ai=None):
    llm = FakeLLM(ai or assessment())
    out = TestClient(create_app(open_settings, llm_client=llm)).post(URL, json=body).json()
    return out, llm


EXCEEDS_Q = defect("EXCEEDS_CONSTRAINTS", line=3, quote="for j in range(i + 1, len(nums)):",
                   description="The pair search is quadratic and too slow for the largest allowed input.")
SLOW_Q = defect("LESS_EFFICIENT_WITHIN_CONSTRAINTS", line=3, quote="for j in range(i + 1, len(nums)):",
                description="The pair search is quadratic, slower than expected.")
LOGIC_Q = defect("LOGIC_SLIP", line=4, quote="if nums[i] + nums[j] == target:", description="The comparison misses one case.")
EXCEEDS_LINEAR = defect("EXCEEDS_CONSTRAINTS", line=3, quote="for i, x in enumerate(nums):", description="Too slow.")
LOGIC_LINEAR = defect()


def assert_re_evaluate(out, llm, code, ai_called=True):
    assert out["status"] == "RE_EVALUATE" and out["reEvaluate"]["code"] == code
    assert out["logicBand"] is None and out["bandSource"] is None and out["defects"] == [] and out["reasoning"] is None
    assert not {"marks", "score"} & set(out)
    assert (len(llm.calls) == 1) is ai_called


# ------------------------------------------------------------------------------------------------ complete passing Submit


@pytest.mark.parametrize("code", [CODE, QUADRATIC, EXPONENTIAL], ids=["two-sum-O(n)", "two-sum-O(n^2)", "fib-O(2^n)"])
@pytest.mark.parametrize("large", [False, True], ids=["small-tests", "with-large-input-test"])
def test_a_complete_passing_submit_is_100_from_execution_whatever_the_complexity(open_settings, code, large):
    cat = "large_input" if large else "normal"
    body = submit(code, [(P, "normal"), (P, "normal"), (P, "normal"), (P, cat)])
    # an AI reply that would call it slow is never even requested
    out, llm = post(open_settings, body, assessment(defects=[SLOW_Q], band=75))
    assert (out["status"], out["logicBand"], out["bandSource"]) == ("EVALUATED", 100, "EXECUTION")
    assert llm.calls == []


# ------------------------------------------------------------------------------------------------ EXCEEDS_CONSTRAINTS


def test_verified_candidate_timeout_supports_exceeds_constraints_as_the_only_defect(open_settings):
    body = submit(QUADRATIC, [(P, "normal"), (P, "normal"), (P, "edge"), (VERIFIED_TL, "large_input")])
    out, llm = post(open_settings, body, assessment(defects=[EXCEEDS_Q], band=50, reasoning="The quadratic search times out on the largest input."))
    assert (out["status"], out["logicBand"], out["bandSource"]) == ("EVALUATED", 50, "AI_RUBRIC") and len(llm.calls) == 1
    assert (out["defects"][0]["kind"], out["defects"][0]["severity"]) == ("EFFICIENCY", "SIGNIFICANT")


def test_verified_timeout_supports_exceeds_even_if_another_large_test_passed(open_settings):
    body = submit(QUADRATIC, [(P, "normal"), (P, "large_input"), (P, "normal"), (VERIFIED_TL, "large_input")])
    out, _ = post(open_settings, body, assessment(defects=[EXCEEDS_Q], band=50, reasoning="Times out on one large input."))
    assert (out["status"], out["logicBand"]) == ("EVALUATED", 50)


def test_exponential_recursion_with_verified_timeout(open_settings):
    ex = defect("EXCEEDS_CONSTRAINTS", line=4, quote="return fib(n - 1) + fib(n - 2)", description="Exponential recursion.")
    body = submit(EXPONENTIAL, [(P, "normal"), (P, "normal"), (VERIFIED_TL, "large_input")])
    out, _ = post(open_settings, body, assessment(defects=[ex], band=50, reasoning="Exponential time on the largest n."))
    assert (out["status"], out["logicBand"]) == ("EVALUATED", 50)


@pytest.mark.parametrize(
    "outcomes",
    [
        [(P, "normal"), (P, "normal"), (P, "normal"), (WA, "edge")],  # only small tests passed: proves nothing
        [(P, "normal"), (WA, "normal"), (WA, "edge")],
    ],
    ids=["small-passes-only", "no-timeout-at-all"],
)
def test_exceeds_constraints_without_a_verified_timeout_is_uncertain(open_settings, outcomes):
    body = submit(CODE, outcomes)
    out, llm = post(open_settings, body, assessment(defects=[LOGIC_LINEAR, EXCEEDS_LINEAR], band=50))
    assert_re_evaluate(out, llm, "EXECUTION_UNCERTAIN")


def test_exceeds_constraints_contradicted_by_a_passed_large_input_test(open_settings):
    body = submit(CODE, [(P, "normal"), (P, "large_input"), (P, "normal"), (WA, "edge")])
    out, llm = post(open_settings, body, assessment(defects=[LOGIC_LINEAR, EXCEEDS_LINEAR], band=50))
    assert_re_evaluate(out, llm, "AI_INCONSISTENT")


# ------------------------------------------------------------------------------------------------ LESS_EFFICIENT_WITHIN_CONSTRAINTS


@pytest.mark.parametrize(
    "outcomes",
    [
        [(P, "normal"), (P, "normal"), (P, "normal"), (WA, "edge")],
        [(P, "normal"), (P, "large_input"), (P, "normal"), (WA, "edge")],  # a large pass is consistent, still unverifiable
    ],
    ids=["no-evidence", "large-input-pass"],
)
def test_less_efficient_within_constraints_never_lowers_the_band(open_settings, outcomes):
    body = submit(QUADRATIC, outcomes)
    out, llm = post(open_settings, body, assessment(defects=[LOGIC_Q, SLOW_Q], band=50))
    assert_re_evaluate(out, llm, "EXECUTION_UNCERTAIN")


def test_less_efficient_within_constraints_contradicted_by_a_verified_timeout(open_settings):
    body = submit(QUADRATIC, [(P, "normal"), (P, "normal"), (P, "normal"), (VERIFIED_TL, "large_input")])
    out, llm = post(open_settings, body, assessment(defects=[SLOW_Q], band=75))
    assert_re_evaluate(out, llm, "AI_INCONSISTENT")


# ------------------------------------------------------------------------------------------------ H6 still decides timeouts


@pytest.mark.parametrize(
    ("outcomes", "execution", "code"),
    [
        ([(P, "normal"), (P, "normal"), (VERIFIED_TL, "large_input")], {"runnerOverloaded": True}, "INFRASTRUCTURE_FAILURE"),
        ([(P, "normal"), (P, "normal"), (VERIFIED_TL, "large_input")], {"runnerFailure": "SERVICE_TIMEOUT"}, "INFRASTRUCTURE_FAILURE"),
        ([(P, "normal"), (P, "normal"), (WALL_ONLY_TL, "large_input")], {}, "EXECUTION_UNCERTAIN"),
    ],
    ids=["runner-overloaded", "service-timeout", "ambiguous-timeout"],
)
def test_infrastructure_and_uncertain_timeouts_never_support_an_efficiency_band(open_settings, outcomes, execution, code):
    body = submit(QUADRATIC, outcomes, **execution)
    out, llm = post(open_settings, body, assessment(defects=[EXCEEDS_Q], band=50))
    assert_re_evaluate(out, llm, code, ai_called=False)


# ------------------------------------------------------------------------------------------------ unchanged behaviour


def test_no_efficiency_criterion_means_no_change(open_settings):
    out, _ = post(open_settings, submit(QUADRATIC, [(P, "normal"), (P, "normal"), (P, "large_input"), (WA, "edge")]),
                  assessment(defects=[LOGIC_Q], band=75))
    assert (out["status"], out["logicBand"]) == ("EVALUATED", 75)


def test_policy_version_records_the_change(open_settings):
    out, _ = post(open_settings, submit(QUADRATIC, [(P, "normal"), (WA, "normal")]), assessment(defects=[LOGIC_Q], band=75))
    assert out["versions"]["policyVersion"] == "aaie-dsa-logic-band-policy-v4"
    assert out["versions"]["rubricVersion"] == "logic-rubric-v1"  # the rubric itself is unchanged


def test_code_hash_of_synthetic_solutions_is_checked():
    assert hashlib.sha256(QUADRATIC.encode()).hexdigest() == submit(QUADRATIC, [(P, "normal")])["submission"]["codeHash"]
