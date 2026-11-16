"""Band 100 only from a verified, complete Submit; incomplete, contradictory or missing evidence -> RE_EVALUATE.

Every RE_EVALUATE here must come without asking the AI and without any band.
"""

import pytest
from fakes import FakeLLM, assessment, defect, request
from fastapi.testclient import TestClient

from app.main import create_app

URL = "/v1/dsa/evaluate"


def case(i, *, hidden, status="passed"):
    return {"caseId": f"c{i}", "hidden": hidden, "category": "normal", "status": status}


SAMPLE_AND_HIDDEN = [case(1, hidden=False), case(2, hidden=False), case(3, hidden=True), case(4, hidden=True)]


def evaluate(open_settings, body):
    llm = FakeLLM(assessment())
    res = TestClient(create_app(open_settings, llm_client=llm)).post(URL, json=body)
    assert res.status_code == 200
    return res.json(), llm


def assert_re_evaluate_without_ai(body, llm):
    assert body["status"] == "RE_EVALUATE"
    assert body["logicBand"] is None and body["bandSource"] is None and body["defects"] == []
    assert body["reEvaluate"]["code"] == "EXECUTION_INCOMPLETE"
    assert llm.calls == []


# ---------------------------------------------------------------------------------------------- the only way to 100


def test_verified_complete_submit_with_hidden_cases_gets_100(open_settings):
    req = request(verdict="passed", passed=4, total=4, cases=SAMPLE_AND_HIDDEN, kind="SUBMIT", expected_total=4)
    body, llm = evaluate(open_settings, req)
    assert (body["status"], body["logicBand"], body["bandSource"]) == ("EVALUATED", 100, "EXECUTION")
    assert llm.calls == []


# ---------------------------------------------------------------------------------------------- incomplete / missing


@pytest.mark.parametrize(
    "req",
    [
        # a Run (sample cases only), even if every sample passed
        request(verdict="passed", passed=2, total=2, cases=[case(1, hidden=False), case(2, hidden=False)], kind="RUN", expected_total=2),
        # labelled SUBMIT but no hidden case was executed
        request(verdict="passed", passed=2, total=2, cases=[case(1, hidden=False), case(2, hidden=False)], kind="SUBMIT", expected_total=2),
        # a Submit that executed only part of the expected cases
        request(verdict="passed", passed=3, total=3, cases=SAMPLE_AND_HIDDEN[:3], kind="SUBMIT", expected_total=4),
        # counts only, no case evidence
        request(verdict="passed", passed=4, total=4, cases=[], kind="SUBMIT", expected_total=4),
        # kind missing
        request(verdict="passed", passed=4, total=4, cases=SAMPLE_AND_HIDDEN, kind=None, expected_total=4),
        # expected total missing
        request(verdict="passed", passed=4, total=4, cases=SAMPLE_AND_HIDDEN, kind="SUBMIT", expected_total=None),
        # kind and expected total both missing (the old request shape)
        request(verdict="passed", passed=4, total=4, cases=SAMPLE_AND_HIDDEN, kind=None, expected_total=None),
    ],
    ids=["run-only", "submit-without-hidden", "partial-submit", "counts-only", "kind-missing", "expected-total-missing", "old-shape"],
)
def test_all_passed_without_a_verified_complete_submit_is_re_evaluate(open_settings, req):
    assert_re_evaluate_without_ai(*evaluate(open_settings, req))


# ---------------------------------------------------------------------------------------------- contradictory


@pytest.mark.parametrize(
    "req",
    [
        # verdict "passed" while a case failed
        request(verdict="passed", passed=3, total=4, kind="SUBMIT", expected_total=4),
        # verdict "failed" while every case passed
        request(verdict="failed", passed=4, total=4, cases=SAMPLE_AND_HIDDEN, kind="SUBMIT", expected_total=4),
        # verdict "compile_error" with cases that ran
        request(
            verdict="compile_error", passed=1, total=2,
            cases=[case(1, hidden=False), case(2, hidden=True, status="wrong_answer")], kind="SUBMIT", expected_total=2,
        ),
        # a compile_error case under a "failed" verdict
        request(
            verdict="failed", passed=1, total=2,
            cases=[case(1, hidden=False), case(2, hidden=True, status="compile_error")], kind="SUBMIT", expected_total=2,
        ),
        # duplicate case ids (the same case counted twice)
        request(
            verdict="passed", passed=4, total=4,
            cases=[case(1, hidden=False), case(1, hidden=False), case(3, hidden=True), case(3, hidden=True)],
            kind="SUBMIT", expected_total=4,
        ),
    ],
    ids=["passed-with-failed-case", "failed-with-all-passed", "compile-error-with-run-cases", "compile-case-under-failed", "duplicate-case-ids"],
)
def test_contradictory_evidence_is_re_evaluate(open_settings, req):
    assert_re_evaluate_without_ai(*evaluate(open_settings, req))


# ---------------------------------------------------------------------------------------------- unchanged behaviour


def test_a_genuine_compile_error_still_goes_to_the_ai(open_settings):
    cases = [case(i, hidden=i > 1, status="compile_error") for i in range(1, 4)]
    req = request(verdict="compile_error", passed=0, total=3, cases=cases, compile_output="SyntaxError", kind="SUBMIT", expected_total=3)
    llm = FakeLLM(assessment(defects=[defect("SYNTAX_SLIP")], band=75))
    body = TestClient(create_app(open_settings, llm_client=llm)).post(URL, json=req).json()
    assert (body["status"], body["logicBand"]) == ("EVALUATED", 75) and len(llm.calls) == 1


def test_failed_tests_still_go_to_the_ai(open_settings):
    body, llm = evaluate(open_settings, request(kind="SUBMIT", expected_total=4))
    assert (body["status"], body["logicBand"]) == ("EVALUATED", 75) and len(llm.calls) == 1


# ---------------------------------------------------------------------------------------------- failed tests: evidence gaps


FAILED_SUBMIT = [case(1, hidden=False), case(2, hidden=False), case(3, hidden=True), case(4, hidden=True, status="wrong_answer")]


@pytest.mark.parametrize(
    "req",
    [
        # kind missing (a failed submission)
        request(kind=None),
        # expectedTotal missing
        request(expected_total=None),
        # both missing (the old request shape)
        request(kind=None, expected_total=None),
        # a RUN without expectedTotal
        request(kind="RUN", expected_total=None, cases=[case(1, hidden=False), case(2, hidden=False, status="wrong_answer")], passed=1, total=2),
        # SUBMIT: counts only, no test results
        request(cases=[], kind="SUBMIT", expected_total=4),
        # SUBMIT: only 3 of the 4 expected cases executed (one failed)
        request(verdict="failed", passed=2, total=3, cases=FAILED_SUBMIT[1:], kind="SUBMIT", expected_total=4),
        # SUBMIT: more results than expected
        request(verdict="failed", passed=3, total=4, cases=FAILED_SUBMIT, kind="SUBMIT", expected_total=3),
        # SUBMIT without any hidden case
        request(
            verdict="failed", passed=1, total=2,
            cases=[case(1, hidden=False), case(2, hidden=False, status="wrong_answer")], kind="SUBMIT", expected_total=2,
        ),
    ],
    ids=["kind-missing", "expected-total-missing", "old-shape", "run-without-expected-total", "submit-counts-only",
         "submit-partial", "submit-more-than-expected", "submit-without-hidden"],
)
def test_missing_or_incomplete_evidence_with_failed_tests_is_re_evaluate_not_a_lower_band(open_settings, req):
    assert_re_evaluate_without_ai(*evaluate(open_settings, req))


def test_complete_failed_submit_still_goes_to_the_ai(open_settings):
    req = request(verdict="failed", passed=3, total=4, cases=FAILED_SUBMIT, kind="SUBMIT", expected_total=4)
    body, llm = evaluate(open_settings, req)
    assert (body["status"], body["logicBand"], body["bandSource"]) == ("EVALUATED", 75, "AI_RUBRIC") and len(llm.calls) == 1


@pytest.mark.parametrize("expected_total", [2, 5])  # a RUN is not held to the Submit coverage rule
def test_valid_run_with_failed_tests_still_goes_to_the_ai(open_settings, expected_total):
    cases = [case(1, hidden=False), case(2, hidden=False, status="wrong_answer")]
    req = request(verdict="failed", passed=1, total=2, cases=cases, kind="RUN", expected_total=expected_total)
    body, llm = evaluate(open_settings, req)
    assert (body["status"], body["logicBand"]) == ("EVALUATED", 75) and len(llm.calls) == 1


def test_unknown_kind_is_refused(open_settings):
    req = request(verdict="passed", passed=4, total=4, kind="PRACTICE", expected_total=4)
    res = TestClient(create_app(open_settings, llm_client=FakeLLM(assessment()))).post(URL, json=req)
    assert res.status_code == 422
