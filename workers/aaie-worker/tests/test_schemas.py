import pytest
from pydantic import ValidationError

from app.schemas.evaluation import (
    CaseCategory,
    CaseResult,
    CaseStatus,
    ErrorClass,
    HealthResponse,
    SubmissionEvidence,
)

HASH = "a" * 64


def evidence(**over) -> dict:
    base = {
        "kind": "SUBMIT",
        "captureKey": "3f0c2a9e-1b7d-4e55-9a10-6d2f4c8b7e01",
        "captureKeySource": "CLIENT",
        "language": "python",
        "engine": "PISTON",
        "codeHash": HASH,
        "verdict": "failed",
        "passed": 1,
        "total": 2,
        "evaluationCompleted": True,
        "progressPersisted": True,
        "cases": [
            {"caseId": "s1", "hidden": False, "category": "normal", "status": "passed", "timeMs": 12, "memoryKb": 900},
            {"caseId": "h1", "hidden": True, "category": "edge", "status": "wrong_answer", "timeMs": 15},
        ],
    }
    base.update(over)
    return base


def test_valid_dsa_evidence_parses_from_camel_case_json():
    e = SubmissionEvidence.model_validate(evidence())
    assert e.passed == 1 and e.cases[1].category is CaseCategory.EDGE and e.cases[1].status is CaseStatus.WRONG_ANSWER
    assert e.model_dump(by_alias=True)["codeHash"] == HASH


def test_valid_sql_run_evidence_parses():
    e = SubmissionEvidence.model_validate(
        evidence(kind="RUN", language="sql", engine="SQLITE", progressPersisted=False, verdict="passed", passed=1, total=1,
                 cases=[{"caseId": "d1", "hidden": False, "category": "null_values", "status": "passed"}])
    )
    assert e.engine.value == "SQLITE"


def test_compile_error_without_cases_parses():
    e = SubmissionEvidence.model_validate(evidence(verdict="compile_error", passed=0, total=3, cases=[]))
    assert e.total == 3


@pytest.mark.parametrize(
    "over",
    [
        {"unexpected": 1},  # unknown field
        {"passed": 3, "total": 2, "cases": []},  # passed > total
        {"passed": 2},  # passed does not match the cases
        {"total": 3},  # total does not match the cases
        {"kind": "SAVE"},  # bad enum
        {"verdict": "ok"},
        {"language": "ruby"},
        {"codeHash": "XYZ"},
        {"captureKey": "short"},
        {"captureKey": "has spaces in it"},
        {"language": "sql", "engine": "PISTON"},  # SQL must run on the sandbox
        {"language": "python", "engine": "SQLITE"},
        {"kind": "RUN", "progressPersisted": True},  # a Run never saves progress
        {"passed": -1, "cases": []},
    ],
)
def test_invalid_evidence_is_rejected(over):
    with pytest.raises(ValidationError):
        SubmissionEvidence.model_validate(evidence(**over))


def test_duplicate_case_ids_are_rejected():
    cases = [{"caseId": "x", "hidden": False, "status": "passed"}, {"caseId": "x", "hidden": True, "status": "passed"}]
    with pytest.raises(ValidationError):
        SubmissionEvidence.model_validate(evidence(cases=cases, passed=2, total=2, verdict="passed"))


def test_case_result_has_no_place_for_hidden_inputs_or_outputs():
    with pytest.raises(ValidationError):
        CaseResult.model_validate({"caseId": "h1", "hidden": True, "status": "passed", "expectedOutput": "42"})
    with pytest.raises(ValidationError):
        CaseResult.model_validate({"caseId": "h1", "hidden": True, "status": "passed", "timeMs": -5})


def test_models_are_immutable():
    e = SubmissionEvidence.model_validate(evidence())
    with pytest.raises(ValidationError):
        e.passed = 2  # type: ignore[misc]


def test_health_response_serialises_camel_case_and_error_class_values():
    assert HealthResponse(service="aaie-worker", version="0.1.0").model_dump(by_alias=True) == {
        "status": "ok",
        "service": "aaie-worker",
        "version": "0.1.0",
        "aiEnabled": False,
    }
    assert [c.value for c in ErrorClass] == ["NONE", "CANDIDATE", "INFRASTRUCTURE"]
