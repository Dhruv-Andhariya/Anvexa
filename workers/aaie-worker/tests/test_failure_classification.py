"""H6 benchmark: infrastructure failures vs candidate failures, from trusted execution metadata only.

Synthetic evidence, Gemini mocked. Infrastructure and uncertain failures must return RE_EVALUATE without calling the AI
and without any band (so never a lower band); genuine candidate failures proven by metadata are evaluated as before.
Limits used: CPU 4000 ms, wall 5000 ms, memory 262144 KB (fakes.LIMITS).
"""

import pytest
from fakes import FakeLLM, assessment, request
from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.dsa_evaluation import DsaExecution, FailureSource
from app.services.failure_classifier import classify_case, classify_execution

URL = "/v1/dsa/evaluate"
P = {"status": "passed"}


def sub(*failing, **execution):
    """Three passed cases (one sample, two hidden) plus the given failing case(s), all hidden; no default metadata."""
    cases = [{"caseId": f"c{i}", "hidden": i > 1, **c} for i, c in enumerate([P, P, P, *failing], start=1)]
    statuses = [c["status"] for c in cases]
    passed = statuses.count("passed")
    body = request(verdict="passed" if passed == len(cases) else "failed", passed=passed, total=len(cases), cases=cases,
                   candidate_metadata=False)
    body["execution"].update(execution)
    return body


def post(open_settings, body, ai=None):
    llm = FakeLLM(ai or assessment())
    out = TestClient(create_app(open_settings, llm_client=llm)).post(URL, json=body).json()
    return out, llm


def assert_no_band_no_ai(out, llm, code):
    assert out["status"] == "RE_EVALUATE" and out["reEvaluate"]["code"] == code
    assert out["logicBand"] is None and out["bandSource"] is None and out["approach"] is None
    assert out["defects"] == [] and out["reasoning"] is None and not {"marks", "score"} & set(out)
    assert llm.calls == []


RE = {"status": "runtime_error"}
TL = {"status": "time_limit"}

# ------------------------------------------------------------------------------------------------ infrastructure

INFRASTRUCTURE = [
    ("piston-unavailable-no-results", request(verdict="failed", passed=0, total=0, cases=[], kind="RUN", expected_total=1), "RUNNER_UNAVAILABLE"),
    ("piston-unavailable-partial", sub(RE), "RUNNER_UNAVAILABLE"),
    ("runner-busy", sub(TL), "RUNNER_BUSY"),
    ("network-error", sub(RE), "NETWORK_ERROR"),
    ("network-timeout", sub(TL), "SERVICE_TIMEOUT"),
    ("worker-crash", sub(RE), "WORKER_CRASH"),
    ("environment-error", sub(RE), "ENVIRONMENT_ERROR"),
]


@pytest.mark.parametrize(("body", "failure"), [(b, f) for _, b, f in INFRASTRUCTURE], ids=[i for i, _, _ in INFRASTRUCTURE])
def test_runner_failures_are_infrastructure_never_candidate_defects(open_settings, body, failure):
    body["execution"]["runnerFailure"] = failure
    assert_no_band_no_ai(*post(open_settings, body), "INFRASTRUCTURE_FAILURE")


@pytest.mark.parametrize(
    "body",
    [
        sub({"status": "internal_error"}),
        sub({**RE, "runnerStatus": "XX", "exitCode": 1, "exceptionInCandidateCode": True}),  # XX wins over any evidence
        sub({**RE, "exitCode": 127}),  # runtime / command missing in the sandbox
        sub({**RE, "exitCode": 126}),
        sub({**TL, "timeMs": 3950, "wallTimeMs": 5000}, runnerOverloaded=True),  # runner overload: re-run
        sub({**TL, "timeMs": 200, "wallTimeMs": 5000}, runnerOverloaded=True),
        sub({**TL, "timeMs": 3950}, {**RE, "runnerStatus": "XX"}),  # a candidate timeout next to a runner fault
    ],
    ids=["internal-error", "runner-status-xx", "exit-127", "exit-126", "overload-cpu-at-limit", "overload-wall-only",
         "mixed-with-runner-fault"],
)
def test_case_level_infrastructure_failures_never_reach_the_ai(open_settings, body):
    assert_no_band_no_ai(*post(open_settings, body), "INFRASTRUCTURE_FAILURE")


# ------------------------------------------------------------------------------------------------ uncertain


@pytest.mark.parametrize(
    "body",
    [
        sub({**TL, "timeMs": 300, "wallTimeMs": 5000}),  # wall clock hit, CPU idle: overload, stall or a blocked read
        sub(TL),  # no CPU time
        sub({**TL, "timeMs": 3950}, limits=None),  # no limits to compare with
        sub(RE),  # a runtime error with no evidence at all
        sub({**RE, "signal": "SIGKILL"}),  # killed from outside, neither memory nor CPU cap reached
        sub({**RE, "exitCode": 137}),
        sub({**RE, "exitCode": 1, "exceptionInCandidateCode": False}),  # non-zero exit, no trace in candidate code
        sub({**RE, "exceptionInCandidateCode": True}),  # a trace but no exit code
        sub({**TL, "timeMs": 3950}, {**RE, "signal": "SIGKILL"}),  # one proven, one not
    ],
    ids=["ambiguous-timeout", "timeout-no-cpu-time", "timeout-no-limits", "runtime-error-no-evidence", "external-sigkill",
         "exit-137", "non-zero-exit-no-trace", "trace-without-exit", "mixed-proven-and-unproven"],
)
def test_uncertain_failures_return_re_evaluate_without_the_ai(open_settings, body):
    if body["execution"].get("limits") is None:
        body["execution"].pop("limits", None)
    assert_no_band_no_ai(*post(open_settings, body), "EXECUTION_UNCERTAIN")


def test_compile_timeout_is_uncertain(open_settings):
    cases = [{"caseId": f"c{i}", "hidden": i > 1, "status": "compile_error", "runnerStatus": "TO"} for i in range(1, 4)]
    body = request(verdict="compile_error", passed=0, total=3, cases=cases, compile_output="Compilation time limit exceeded.")
    assert_no_band_no_ai(*post(open_settings, body), "EXECUTION_UNCERTAIN")


def test_a_failed_run_without_per_case_results_cannot_be_attributed(open_settings):
    body = request(verdict="failed", passed=1, total=2, cases=[], kind="RUN", expected_total=2)
    assert_no_band_no_ai(*post(open_settings, body), "EXECUTION_UNCERTAIN")


# ------------------------------------------------------------------------------------------------ genuine candidate


@pytest.mark.parametrize(
    "body",
    [
        sub({**RE, "exitCode": 1, "exceptionInCandidateCode": True}),  # Python traceback in the candidate's lines
        sub({**RE, "signal": "SIGSEGV", "exitCode": 139}),  # C++ out-of-bounds access
        sub({**RE, "signal": "SIGFPE"}),  # division by zero
        sub({**RE, "signal": "SIGABRT"}),  # uncaught C++ exception / failed assert
        sub({**RE, "signal": "SIGKILL", "memoryKb": 262000}),  # memory limit exceeded
        sub({**RE, "signal": "SIGKILL", "timeMs": 3990}),  # killed at the CPU limit
        sub({**TL, "timeMs": 3950, "wallTimeMs": 5000}),  # a genuine time-limit violation
        sub({**TL, "timeMs": 4000, "wallTimeMs": 4100}, runnerOverloaded=False),
        sub({"status": "wrong_answer"}),  # the program ran to the end
    ],
    ids=["python-exception", "cpp-sigsegv", "sigfpe", "sigabrt", "memory-limit", "sigkill-at-cpu-limit", "candidate-tle",
         "candidate-tle-not-overloaded", "wrong-answer"],
)
def test_proven_candidate_failures_are_evaluated(open_settings, body):
    out, llm = post(open_settings, body)
    assert (out["status"], out["logicBand"], out["bandSource"]) == ("EVALUATED", 75, "AI_RUBRIC")
    assert len(llm.calls) == 1
    assert "verified by the platform as caused by the candidate's code" in llm.calls[0]["prompt"]


def test_a_genuine_compile_error_is_evaluated(open_settings):
    from fakes import defect

    cases = [{"caseId": f"c{i}", "hidden": i > 1, "status": "compile_error"} for i in range(1, 4)]
    body = request(verdict="compile_error", passed=0, total=3, cases=cases, compile_output="SyntaxError")
    out, _ = post(open_settings, body, assessment(defects=[defect("SYNTAX_SLIP")], band=75))
    assert (out["status"], out["logicBand"]) == ("EVALUATED", 75)


# ------------------------------------------------------------------------------------------------ never a lower band


@pytest.mark.parametrize("ai", [assessment(approach="WRONG_OR_MISSING", defects=[], band=0, reasoning="Wrong approach."),
                                assessment(defects=[], band=100, reasoning="Fine.")])
@pytest.mark.parametrize(
    "body",
    [sub({**TL, "timeMs": 300, "wallTimeMs": 5000}), sub({**RE, "runnerStatus": "XX"}), sub(RE, runnerFailure="NETWORK_ERROR")],
    ids=["ambiguous-timeout", "runner-fault", "network"],
)
def test_infrastructure_or_uncertain_failures_never_get_any_band(open_settings, body, ai):
    out, llm = post(open_settings, body, ai)
    assert out["status"] == "RE_EVALUATE" and out["logicBand"] is None and llm.calls == []


def test_all_passed_submit_is_unaffected(open_settings):
    out, llm = post(open_settings, request(verdict="passed", passed=4, total=4))
    assert (out["logicBand"], out["bandSource"]) == (100, "EXECUTION") and llm.calls == []


def test_the_ai_cannot_claim_an_infrastructure_cause(open_settings):
    out, _ = post(open_settings, sub({**TL, "timeMs": 3950}), assessment(reasoning="The timeout is due to the server."))
    assert out["status"] == "RE_EVALUATE" and out["reEvaluate"]["code"] == "AI_INCONSISTENT"  # H3 still refuses it


# ------------------------------------------------------------------------------------------------ contract + unit


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b["execution"].update(runnerFailure="SOMETHING_ELSE"),
        lambda b: b["execution"]["cases"][3].update(signal="kill -9"),
        lambda b: b["execution"]["cases"][3].update(runnerStatus="ZZ"),
        lambda b: b["execution"]["cases"][3].update(exitCode=999),
        lambda b: b["execution"].update(limits={"cpuMs": 0, "wallMs": 1, "memoryKb": 1}),
    ],
    ids=["unknown-runner-failure", "bad-signal", "bad-runner-status", "bad-exit-code", "bad-limits"],
)
def test_malformed_metadata_is_refused(open_settings, mutate):
    body = sub(RE)
    mutate(body)
    assert TestClient(create_app(open_settings, llm_client=FakeLLM(assessment()))).post(URL, json=body).status_code == 422


def test_classifier_is_deterministic_and_conservative():
    ex = DsaExecution.model_validate(sub({**TL, "timeMs": 3599, "wallTimeMs": 5000})["execution"])
    assert classify_case(ex.cases[3], ex) is FailureSource.UNCERTAIN  # below 90 % of the CPU limit
    ex = DsaExecution.model_validate(sub({**TL, "timeMs": 3600, "wallTimeMs": 5000})["execution"])
    assert classify_case(ex.cases[3], ex) is FailureSource.CANDIDATE  # exactly 90 %
    assert classify_execution(ex) is classify_execution(ex) is FailureSource.CANDIDATE
    assert classify_case(ex.cases[0], ex) is FailureSource.CANDIDATE  # a passed case never blocks
