"""H1: severity comes from the rubric criterion, never from the AI. H2: the same mistake counts once.

Gemini is mocked; the code is the synthetic two_sum in fakes.CODE:
   1 def two_sum(nums, target):
   2     seen = {}
   3     for i, x in enumerate(nums):
   4         if target - x in seen:
   5             return [seen[target - x], i]
   6         seen[x] = i
   7     return []
"""

import json

import pytest
from fakes import FakeLLM, assessment, defect, request
from fastapi.testclient import TestClient

from app.schemas.dsa_evaluation import DefectKind, DefectSeverity, RubricCriterion
from app.services.rubric_validator import CRITERIA

URL = "/v1/dsa/evaluate"


def evaluate(open_settings, reply, req=None):
    from app.main import create_app

    return TestClient(create_app(open_settings, llm_client=FakeLLM(reply))).post(URL, json=req or request()).json()


def ev(line, quote, end=None):
    return {"line_start": line, "line_end": end or line, "quote": quote}


# ================================================================================================ H1 severity


EXPECTED = {
    "SYNTAX_SLIP": ("SYNTAX", "MINOR"),
    "LOGIC_SLIP": ("LOGIC", "MINOR"),
    "MISSED_EDGE_CASE": ("EDGE_CASE", "MINOR"),
    "LESS_EFFICIENT_WITHIN_CONSTRAINTS": ("EFFICIENCY", "MINOR"),
    "EDGE_CASE_CLASS_UNHANDLED": ("EDGE_CASE", "SIGNIFICANT"),
    "INCORRECT_STATE_UPDATES": ("LOGIC", "SIGNIFICANT"),
    "MISSING_OR_PARTIAL_STEP": ("INCOMPLETE", "SIGNIFICANT"),
    "EXCEEDS_CONSTRAINTS": ("EFFICIENCY", "SIGNIFICANT"),
}


def test_every_criterion_has_exactly_one_rubric_severity():
    assert set(CRITERIA) == set(RubricCriterion)
    assert {c.value: (k.value, s.value) for c, (k, s) in CRITERIA.items()} == EXPECTED
    assert CRITERIA[RubricCriterion.SYNTAX_SLIP] == (DefectKind.SYNTAX, DefectSeverity.MINOR)
    assert CRITERIA[RubricCriterion.MISSING_OR_PARTIAL_STEP] == (DefectKind.INCOMPLETE, DefectSeverity.SIGNIFICANT)


@pytest.mark.parametrize(("criterion", "kind_severity"), EXPECTED.items())
def test_severity_and_kind_are_set_by_the_worker_from_the_criterion(open_settings, criterion, kind_severity):
    band = 75 if kind_severity[1] == "MINOR" else 50
    # the failing case's status must be one this kind of defect can cause (H3)
    status = {"SYNTAX": "runtime_error", "EFFICIENCY": "time_limit"}.get(kind_severity[0], "wrong_answer")
    cases = [{"caseId": f"c{i}", "hidden": i > 1, "status": "passed" if i <= 3 else status} for i in range(1, 5)]
    body = evaluate(open_settings, assessment(defects=[defect(criterion)], band=band), request(cases=cases))
    if criterion == "LESS_EFFICIENT_WITHIN_CONSTRAINTS":
        # H7 (D-H7 Option A): never a band on this claim; next to a verified timeout it is contradicted
        assert (body["status"], body["logicBand"], body["reEvaluate"]["code"]) == ("RE_EVALUATE", None, "AI_INCONSISTENT")
        return
    assert (body["status"], body["logicBand"]) == ("EVALUATED", band)
    assert (body["defects"][0]["kind"], body["defects"][0]["severity"]) == kind_severity


def test_a_syntax_error_is_always_minor(open_settings):
    cases = [{"caseId": f"c{i}", "hidden": i > 1, "status": "compile_error"} for i in range(1, 4)]
    req = request(verdict="compile_error", passed=0, total=3, cases=cases, compile_output="SyntaxError")
    body = evaluate(open_settings, assessment(defects=[defect("SYNTAX_SLIP")], band=75), req)
    assert (body["logicBand"], body["defects"][0]["severity"]) == (75, "MINOR")
    # an AI that believed the syntax error was significant (band 50) is refused, not obeyed
    assert evaluate(open_settings, assessment(defects=[defect("SYNTAX_SLIP")], band=50), req)["reEvaluate"]["code"] == "AI_INCONSISTENT"


def test_a_missing_essential_step_is_always_significant(open_settings):
    body = evaluate(open_settings, assessment(defects=[defect("MISSING_OR_PARTIAL_STEP")], band=50))
    assert (body["logicBand"], body["defects"][0]["severity"]) == (50, "SIGNIFICANT")
    # an AI that treated it as minor (band 75) is refused, not obeyed
    body = evaluate(open_settings, assessment(defects=[defect("MISSING_OR_PARTIAL_STEP")], band=75))
    assert body["status"] == "RE_EVALUATE" and body["reEvaluate"]["code"] == "AI_INCONSISTENT"


@pytest.mark.parametrize(
    "bad_defect",
    [
        {**defect("SYNTAX_SLIP"), "severity": "SIGNIFICANT"},  # the AI tries to choose a severity
        {**defect("LOGIC_SLIP"), "kind": "INCOMPLETE"},  # ... or a kind
        {"severity": "MINOR", "kind": "LOGIC", "description": "x", "evidence": [ev(4, "if target - x in seen:")]},  # old shape
        defect("SMALL_THING"),  # not a rubric criterion
    ],
    ids=["ai-severity", "ai-kind", "old-shape-no-criterion", "unknown-criterion"],
)
def test_ai_classifications_outside_the_rubric_are_refused(open_settings, bad_defect):
    body = evaluate(open_settings, json.dumps(assessment(defects=[bad_defect])))
    assert body["status"] == "RE_EVALUATE" and body["reEvaluate"]["code"] == "AI_INVALID_OUTPUT" and body["logicBand"] is None


def test_one_mistake_reported_with_two_severities_is_refused(open_settings):
    both = [defect("LOGIC_SLIP"), defect("INCORRECT_STATE_UPDATES", description="State is updated wrongly here.")]
    body = evaluate(open_settings, assessment(defects=both, band=50))
    assert body["status"] == "RE_EVALUATE" and body["reEvaluate"]["code"] == "AI_INCONSISTENT"


def test_the_gemini_schema_has_no_severity_or_kind():
    from app.schemas.dsa_evaluation import GeminiDefectWire

    assert set(GeminiDefectWire.model_fields) == {"criterion", "description", "evidence"}


# ================================================================================================ H2 duplicates


@pytest.mark.parametrize(
    ("defects", "evidence_count"),
    [
        # same criterion, same evidence, different wording
        ([defect(), defect(description="Lookup is wrong for one input.")], 1),
        # the same spot quoted more or less widely
        ([defect(quote="if target - x in seen:"), defect(quote="target - x in seen")], 2),
        # an overlapping line range around the same spot
        ([defect(evidence=[ev(4, "if target - x in seen:", end=5)]), defect(quote="target - x")], 2),
        # the same mistake repeated on another line (identical quote)
        ([defect(line=4, quote="target - x"), defect(line=5, quote="target - x", description="Same again here.")], 2),
        # transitive: A~B on line 4, B~C by the repeated quote on line 5
        ([defect(quote="if target - x in seen:"), defect(quote="target - x"), defect(line=5, quote="target - x")], 3),
    ],
    ids=["reworded", "wider-quote", "overlapping-range", "repeated-on-other-line", "transitive"],
)
def test_the_same_mistake_counts_once_and_keeps_all_evidence(open_settings, defects, evidence_count):
    body = evaluate(open_settings, assessment(defects=defects, band=75))
    assert (body["status"], body["logicBand"]) == ("EVALUATED", 75)
    assert len(body["defects"]) == 1 and len(body["defects"][0]["evidence"]) == evidence_count
    assert body["defects"][0]["description"] == defects[0]["description"]  # first report's wording


def test_identical_evidence_is_kept_once(open_settings):
    body = evaluate(open_settings, assessment(defects=[defect(), defect(), defect()], band=75))
    assert body["defects"][0]["evidence"] == [{"lineStart": 4, "lineEnd": 4, "quote": "if target - x in seen:"}]


def test_a_proposal_that_counted_the_duplicate_twice_gets_the_deduplicated_band(open_settings):
    body = evaluate(open_settings, assessment(defects=[defect(), defect(description="Reworded.")], band=50))
    assert (body["status"], body["logicBand"], len(body["defects"])) == ("EVALUATED", 75, 1)


def test_a_proposal_matching_neither_count_is_still_refused(open_settings):
    body = evaluate(open_settings, assessment(defects=[defect(), defect(description="Reworded.")], band=25))
    assert body["reEvaluate"]["code"] == "AI_INCONSISTENT"


@pytest.mark.parametrize(
    "defects",
    [
        # different spots on one line (neither quote contains the other)
        [defect(line=5, quote="seen[target - x]"), defect(line=5, quote="i]")],
        # a short identical quote on different lines is not "the same mistake repeated"
        [defect(line=5, quote="i"), defect(line=6, quote="i")],
        # same place, different kinds of mistake
        [defect("LOGIC_SLIP"), defect("MISSED_EDGE_CASE", description="Empty input is not handled.")],
        # different lines, different code
        [defect(), defect(line=5, quote="return [seen[target - x], i]")],
    ],
    ids=["two-spots-one-line", "short-quote-other-line", "different-kind-same-place", "different-places"],
)
def test_distinct_mistakes_stay_separate(open_settings, defects):
    body = evaluate(open_settings, assessment(defects=defects, band=50))
    assert (body["status"], body["logicBand"], len(body["defects"])) == ("EVALUATED", 50, 2)


def test_deduplication_does_not_depend_on_report_order(open_settings):
    defects = [defect(quote="target - x"), defect(line=6, quote="seen[x] = i"), defect(line=5, quote="target - x"), defect()]
    forward = evaluate(open_settings, assessment(defects=defects, band=50))
    backward = evaluate(open_settings, assessment(defects=list(reversed(defects)), band=50))
    assert forward["logicBand"] == backward["logicBand"] == 50
    assert len(forward["defects"]) == len(backward["defects"]) == 2


def test_four_distinct_minor_mistakes_still_give_25(open_settings):
    defects = [defect(), defect(line=5, quote="return [seen[target - x], i]"), defect(line=6, quote="seen[x] = i"),
               defect(line=7, quote="return []")]
    body = evaluate(open_settings, assessment(defects=defects, band=25))
    assert (body["logicBand"], len(body["defects"])) == (25, 4)
