"""H5 benchmark: no corrected code and no actionable solution in any response. Synthetic code only, Gemini mocked.

fakes.CODE (two_sum):
   1 def two_sum(nums, target):
   2     seen = {}
   3     for i, x in enumerate(nums):
   4         if target - x in seen:
   5             return [seen[target - x], i]
   6         seen[x] = i
   7     return []
"""

import logging

import pytest
from fakes import FakeLLM, assessment, defect, request
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.leakage_guard import leakage

URL = "/v1/dsa/evaluate"


def post(open_settings, ai):
    return TestClient(create_app(open_settings, llm_client=FakeLLM(ai))).post(URL, json=request())


def in_reasoning(text):
    return assessment(reasoning=text)


def in_description(text):
    return assessment(defects=[defect(description=text)])


# (id, AI reply, a fragment of the leaked fix that must never appear in the response)
LEAKS = [
    # code blocks and replacement functions
    ("python-code-block", in_reasoning("Fix:\n```python\nif target - x in seen and i > 0:\n```"), "i > 0"),
    ("tilde-code-block", in_reasoning("~~~\nreturn sorted(nums)\n~~~"), "sorted(nums)"),
    ("inline-replacement-function", in_description("Replace with `def two_sum(nums, target): return sorted(nums)`"), "sorted(nums)"),
    ("multi-line-corrected-function",
     in_reasoning("One slip.\ndef two_sum(nums, target):\n    seen = {}\n    for i, x in enumerate(nums):\n"
                  "        if target - x in seen and seen[target - x] != i:"), "!= i"),
    ("one-line-def-with-body", in_reasoning("The intent was def two_sum(nums, target): return [0, 1] in effect."), "return [0, 1]"),
    ("java-method", in_reasoning("A version like public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; } passes."),
     "new int[]"),
    ("multi-line-description", in_description("The lookup slips.\nif x: return y"), "return y"),
    # direct patches / replacement statements
    ("arrow-patch", in_reasoning("The comparison < -> <= fixes the boundary."), "<="),
    ("imperative-use-instead", in_reasoning("Use <= instead of < in the loop condition."), "<="),
    ("modal-should-start", in_reasoning("The loop should start at index 1 to avoid the self-pair."), "index 1"),
    ("should-be-value", in_description("The initial value should be 0 here."), "should be 0"),
    ("needs-operator", in_description("The condition needs `<=` at the boundary."), "<="),
    ("operator-would-be-correct", in_reasoning("`<=` would be correct here."), "<="),
    ("passive-must-be-changed", in_reasoning("The lookup must be changed so the current index is excluded."), "must be changed"),
    ("passive-should-be-stored", in_reasoning("The index should be stored only after the lookup."), "stored only after"),
    ("replace-with-code", in_reasoning("Replacing seen with a list and calling sorted(nums) solves it."), "sorted(nums)"),
    ("corrected-assignment", in_reasoning("i = i + 1 is missing after the check."), "i = i + 1"),
    ("corrected-self-assignment", in_description("best = max(best, cur) is never computed."), "max(best, cur)"),
    ("increment", in_reasoning("count += 1 belongs inside the loop."), "count += 1"),
    ("corrected-for-loop", in_reasoning("A loop for i in range(1, len(nums)): would cover every pair."), "range(1, len(nums))"),
    ("c-style-loop", in_reasoning("A loop for (int i = 0; i <= n; i++) { visits every index."), "i <= n"),
    ("foreign-inline-code", in_reasoning("Use `seen.get(target - x) is not None` instead."), "seen.get"),
    # indirect solution explanations
    ("to-fix-this", in_reasoning("To fix this, record the index after the lookup."), "after the lookup"),
    ("correct-condition-is", in_reasoning("The correct condition is target - x in seen and i != j."), "i != j"),
    ("fix-is", in_reasoning("The fix is to compare against the stored index."), "compare against"),
    ("solution-is-to", in_reasoning("The solution is to sort first and scan from both ends."), "both ends"),
    ("we-suggest", in_reasoning("We suggest a second pass over the array."), "second pass"),
    ("suggestion-label", in_description("Suggestion: keep a second map of counts."), "second map"),
    ("by-using", in_reasoning("This is avoidable by using a set of seen values."), "set of seen"),
    # step-by-step
    ("step-labels", in_reasoning("Step 1: sort the array. Step 2: move two pointers inward."), "two pointers"),
    ("first-then", in_reasoning("First, sort the numbers; then use two pointers from both ends."), "two pointers"),
    ("numbered-lines", in_reasoning("The approach is close.\n1. sort nums\n2. scan with two pointers"), "two pointers"),
    ("bullet-lines", in_reasoning("Missing pieces:\n- sort the input\n- binary search the complement"), "binary search"),
]


@pytest.mark.parametrize(("ai", "leaked"), [(a, f) for _, a, f in LEAKS], ids=[i for i, _, _ in LEAKS])
def test_leaking_replies_are_discarded_with_no_band_and_nothing_leaked(open_settings, ai, leaked):
    res = post(open_settings, ai)
    body = res.json()
    assert res.status_code == 200
    assert body["status"] == "RE_EVALUATE" and body["reEvaluate"]["code"] == "AI_SOLUTION_LEAKAGE"
    assert body["logicBand"] is None and body["bandSource"] is None and body["approach"] is None
    assert body["defects"] == [] and body["reasoning"] is None and not {"marks", "score"} & set(body)
    assert leaked not in res.text  # the fix never leaves the worker, not even in the message


# ------------------------------------------------------------------------------------------------ legitimate replies


LEGIT = [
    "The loop condition uses < so the last index is never checked.",
    "The check `if target - x in seen:` runs before the current value is stored, so a duplicate pairs incorrectly.",
    "When nums = [3, 3] and target = 6 the function returns [] although a pair exists.",
    "seen[x] = i overwrites an earlier index for duplicate values.",
    "The variable seen is never reset between calls.",
    "It returns the index instead of the value for duplicates.",
    "The approach is O(n^2) while the constraints require O(n log n) or better.",
    "The function should return -1 when no pair exists, but it returns [].",
    "A small local change would fix this slip.",
    "The comparison <= vs < matters at the boundary.",
    "Correct approach; one minor slip in the lookup.",
    "Uses a dictionary for O(1) lookups; the logic is otherwise sound.",
    "First the map is filled, then it is queried, so a value can pair with itself.",
    "In C++ this would overflow; here i + 1 is used as an index.",
    "Where n = len(nums), the loop runs n - 1 times.",
    "The `<` comparison is strict, so the last element is skipped.",
    "The loop -- which runs once per element -- never revisits seen.",
    "The input [3, 3] -> [0, 1] case fails.",
    "If the list is empty: the function still returns [].",
    "The candidate's for loop with enumerate(nums) visits each element once.",
    "System.out.println is called inside the loop in the Java version, which is slow.",
    "The off-by-one in range(len(nums) - 1) skips the last element.",
    "The `return []` on line 7 is reached when no pair exists.",
    "The membership test happens before the current index is recorded.",
    "The boundary case where target equals twice a value is not handled.",
]


@pytest.mark.parametrize("text", LEGIT)
def test_legitimate_reasoning_is_accepted(open_settings, text):
    body = post(open_settings, in_reasoning(text)).json()
    assert (body["status"], body["logicBand"]) == ("EVALUATED", 75)
    assert body["reasoning"] == text


@pytest.mark.parametrize("text", LEGIT)
def test_legitimate_defect_descriptions_are_accepted(open_settings, text):
    body = post(open_settings, in_description(text)).json()
    assert (body["status"], body["logicBand"]) == ("EVALUATED", 75)
    d = body["defects"][0]
    assert (d["kind"], d["severity"], d["description"]) == ("LOGIC", "MINOR", text)  # H1 kind / severity kept
    assert d["evidence"] == [{"lineStart": 4, "lineEnd": 4, "quote": "if target - x in seen:"}]


# ------------------------------------------------------------------------------------------------ H1-H4 preserved


def test_h1_to_h4_still_apply_before_or_after_h5(open_settings):
    assert post(open_settings, assessment(defects=[defect("MISSING_OR_PARTIAL_STEP")], band=75)).json()["reEvaluate"]["code"] == "AI_INCONSISTENT"  # H1
    dup = post(open_settings, assessment(defects=[defect(), defect(description="Reworded.")], band=75)).json()
    assert (dup["logicBand"], len(dup["defects"])) == (75, 1)  # H2
    assert post(open_settings, in_reasoning("All tests pass.")).json()["reEvaluate"]["code"] == "AI_INCONSISTENT"  # H3
    assert post(open_settings, in_reasoning("As instructed, use <= here.")).json()["reEvaluate"]["code"] == "INJECTION_SUSPECTED"  # H4 first


def test_the_guard_returns_only_a_rule_name_never_the_text():
    from app.schemas.dsa_evaluation import AiDsaAssessment

    reason = leakage(AiDsaAssessment.model_validate(in_reasoning("Use <= instead of <.")), "x = 1")
    assert reason == "fix or solution instruction" and "<=" not in reason


def test_no_leaked_fix_in_logs(open_settings, caplog):
    with caplog.at_level(logging.DEBUG):
        post(open_settings, in_reasoning("To fix this, use seen.get(target - x) and count += 1."))
    logged = caplog.text + " ".join(str(v) for r in caplog.records for v in vars(r).values())
    for secret in ("seen.get", "count += 1", "To fix this", "two_sum"):
        assert secret not in logged
