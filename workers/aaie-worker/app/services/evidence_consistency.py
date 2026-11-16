"""H3: the AI's assessment must agree with the authoritative execution evidence.

Only *material* contradictions are refused (-> AI_INCONSISTENT -> RE-EVALUATE, no band). The checks are deterministic and
deliberately narrow; anything they cannot decide is left to the rubric, never guessed:

  1. failures must be explainable by the reported defects (CORRECT approach): a wrong answer cannot be explained only
     by an efficiency or syntax defect, a crash not only by an efficiency defect, a timeout not only by a syntax one;
  2. a SYNTAX defect in Java / C++ code that compiled is impossible (Python reports a misspelt name at run time);
  3. "conceptual misunderstanding" (WRONG_OR_MISSING) cannot pass most hidden tests (at least two and more than half);
     the reverse is *not* assumed: failed tests never prove a wrong approach, and a high pass ratio never proves a
     correct one (no rule maps a pass ratio to an approach or a band);
  4. statements in the reasoning / defect descriptions that the execution evidence disproves: test counts
     ("3 of 4 tests"), "all (hidden / sample) tests pass", "every test fails", "fails the hidden tests", "compiles
     successfully" / "does not compile", and claims of full correctness ("the solution is perfect", "no defects")
     while tests failed;
  5. infrastructure is never a candidate defect: runner faults never reach the AI (gemini_evaluator), and an AI text
     that blames the execution infrastructure is refused.

Every failure reaching this check was already attributed to the candidate from trusted metadata
(services/failure_classifier.py, H6); runner faults, overload and uncertain timeouts never get here.

H7 (decision D-H7, Option A - execution wins): efficiency is established by execution, never by the AI alone
(section 8 rule 3: complexity claims are measured). See efficiency_problem below.
"""

from __future__ import annotations

import re

from ..schemas.dsa_evaluation import (
    AiDsaAssessment,
    Approach,
    DefectKind,
    DsaEvaluationRequest,
    DsaExecution,
    FailureSource,
    ReEvaluateCode,
    RubricCriterion,
)
from ..schemas.evaluation import CaseCategory, CaseStatus, Language, Verdict
from .failure_classifier import classify_case

#: Which defect kinds can cause each failing status (rubric v1 kinds).
_EXPLAINS: dict[CaseStatus, frozenset[DefectKind]] = {
    CaseStatus.WRONG_ANSWER: frozenset({DefectKind.LOGIC, DefectKind.EDGE_CASE, DefectKind.INCOMPLETE}),
    CaseStatus.RUNTIME_ERROR: frozenset({DefectKind.LOGIC, DefectKind.EDGE_CASE, DefectKind.INCOMPLETE, DefectKind.SYNTAX}),
    CaseStatus.TIME_LIMIT: frozenset({DefectKind.LOGIC, DefectKind.EDGE_CASE, DefectKind.INCOMPLETE, DefectKind.EFFICIENCY}),
}
_COMPILED = frozenset({Language.JAVA, Language.CPP})

_Q = r"(?P<q>hidden|sample|visible|public|example)?\s*"
_TESTS = r"(?:test\s+cases?|tests?|cases?)\b"
_NEGATION = re.compile(r"(?:\bnot\b|\bnever\b|n't\b|\bcannot\b|\bnor\b)", re.IGNORECASE)

_COUNT_CLAIM = re.compile(r"\b(\d+)\s*(?:/|out\s+of|of)\s*(\d+)\s+(?:\w+\s+){0,2}?" + _TESTS, re.IGNORECASE)
_ALL_PASS = [
    re.compile(r"\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?" + _Q + _TESTS + r"\s+(?:pass|passed|passes|succeed\w*)\b", re.IGNORECASE),
    re.compile(r"\bpass(?:es|ed)?\s+(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?" + _Q + _TESTS, re.IGNORECASE),
]
_ALL_FAIL = [
    re.compile(r"\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?" + _Q + _TESTS + r"\s+fail(?:s|ed)?\b", re.IGNORECASE),
    re.compile(r"\bfail(?:s|ed)?\s+(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?" + _Q + _TESTS, re.IGNORECASE),
    re.compile(r"\bno\s+" + _Q + _TESTS + r"\s+pass(?:es|ed)?\b", re.IGNORECASE),
]
_SOME_FAIL = re.compile(
    r"\bfail(?:s|ed|ing)?\s+(?:on\s+)?(?:the\s+|some\s+|several\s+|a\s+few\s+|one\s+|two\s+|three\s+|\d+\s+)?(?:of\s+the\s+)?"
    r"(?P<q>hidden|sample|visible|public|example)\s+" + _TESTS,
    re.IGNORECASE,
)
_FULLY_CORRECT = re.compile(
    r"\b(?:solution|code|logic|submission|program|implementation)\s+is\s+(?:perfect|flawless|fully\s+correct|"
    r"completely\s+correct|entirely\s+correct)\b|\bcorrect\s+for\s+(?:all|every)\s+(?:valid\s+)?inputs?\b|"
    r"\bno\s+(?:defects?|mistakes?|bugs?)\b",
    re.IGNORECASE,
)
_COMPILES_OK = re.compile(r"\b(?:compiles|compiled)\s+(?:successfully|fine|correctly|without\s+(?:any\s+)?errors?)\b", re.IGNORECASE)
_NO_COMPILE = re.compile(
    r"\b(?:fails?\s+to\s+compile|failed\s+to\s+compile|does\s+not\s+compile|did\s+not\s+compile|doesn't\s+compile|"
    r"didn't\s+compile|compilation\s+(?:error|failed|fails))\b",
    re.IGNORECASE,
)
_INFRA = re.compile(
    r"\b(?:code\s+runner|test\s+runner|execution\s+engine|infrastructure|sandbox|piston|test\s+harness|internal\s+error)\b|"
    r"\b(?:caused\s+by|due\s+to|because\s+of)\s+(?:the\s+)?(?:server|network|platform|environment|grader|judge)\b",
    re.IGNORECASE,
)


def _negated(text: str, start: int) -> bool:
    return bool(_NEGATION.search(text[max(0, start - 30) : start]))


def _subsets(ex: DsaExecution) -> dict[str, tuple[int, int]]:
    """(passed, total) overall and, when the cases are listed, for the hidden and the sample cases."""
    out = {"": (ex.passed, ex.total)}
    if ex.cases:
        for name, hidden in (("hidden", True), ("sample", False)):
            cases = [c for c in ex.cases if c.hidden is hidden]
            out[name] = (sum(c.status is CaseStatus.PASSED for c in cases), len(cases))
    return out


def _subset(subsets: dict[str, tuple[int, int]], qualifier: str | None) -> tuple[int, int] | None:
    key = "" if not qualifier else ("hidden" if qualifier.lower() == "hidden" else "sample")
    pair = subsets.get(key)
    return pair if pair and pair[1] > 0 else None


def _text_contradiction(text: str, ex: DsaExecution, subsets: dict[str, tuple[int, int]]) -> str | None:
    allowed = {pair for p, t in subsets.values() if t > 0 for pair in ((p, t), (t - p, t))}
    for m in _COUNT_CLAIM.finditer(text):
        if (int(m.group(1)), int(m.group(2))) not in allowed:
            return "test counts in the reply do not match the execution results"
    for pattern in _ALL_PASS:
        for m in pattern.finditer(text):
            pair = _subset(subsets, m.group("q"))
            if pair and pair[0] < pair[1] and not _negated(text, m.start()):
                return "the reply says all tests passed, but tests failed"
    for pattern in _ALL_FAIL:
        for m in pattern.finditer(text):
            pair = _subset(subsets, m.group("q"))
            if pair and pair[0] > 0 and not _negated(text, m.start()):
                return "the reply says every test failed, but tests passed"
    for m in _SOME_FAIL.finditer(text):
        pair = _subset(subsets, m.group("q"))
        if pair and pair[0] == pair[1] and not _negated(text, m.start()):
            return "the reply says tests failed that passed"
    if ex.verdict is not Verdict.COMPILE_ERROR:
        for m in _FULLY_CORRECT.finditer(text):
            if not _negated(text, m.start()):
                return "the reply claims full correctness, but tests failed"
        if _NO_COMPILE.search(text):
            return "the reply says the code does not compile, but it compiled"
    else:
        for m in _COMPILES_OK.finditer(text):
            if not _negated(text, m.start()):
                return "the reply says the code compiles, but it did not"
    if _INFRA.search(text):
        return "the reply attributes a failure to the execution infrastructure"
    return None


def efficiency_problem(criteria: list[RubricCriterion], request: DsaEvaluationRequest) -> tuple[ReEvaluateCode, str] | None:
    """H7 (D-H7 Option A): an efficiency criterion is used only when execution evidence supports it.

    Evidence (trusted, never the AI's): a *verified candidate timeout* is a time-limit case that the H6 classifier
    attributes to the candidate (CPU time at the limit, runner not overloaded); a *large-input pass* is a passed case
    tagged `large_input` (D25 performance test). Nothing else - no expected complexity, no maximum input size, no
    small-test timings - is assumed.

      - EXCEEDS_CONSTRAINTS: supported by a verified candidate timeout (also as the only defect); otherwise contradicted
        by a large-input pass (AI_INCONSISTENT) or unverified (EXECUTION_UNCERTAIN);
      - LESS_EFFICIENT_WITHIN_CONSTRAINTS: "valid within the constraints" is contradicted by a verified candidate
        timeout (AI_INCONSISTENT); otherwise it is unverifiable today, because no question carries its expected
        complexity (EXECUTION_UNCERTAIN). It never lowers a band on the AI's word.
    Returns (code, reason) for RE-EVALUATE, or None.
    """
    wanted = {RubricCriterion.EXCEEDS_CONSTRAINTS, RubricCriterion.LESS_EFFICIENT_WITHIN_CONSTRAINTS} & set(criteria)
    if not wanted:
        return None
    ex = request.execution
    verified_timeout = any(
        c.status is CaseStatus.TIME_LIMIT and classify_case(c, ex) is FailureSource.CANDIDATE for c in ex.cases
    )
    large_input_pass = any(c.status is CaseStatus.PASSED and c.category is CaseCategory.LARGE_INPUT for c in ex.cases)

    if RubricCriterion.LESS_EFFICIENT_WITHIN_CONSTRAINTS in wanted and verified_timeout:
        return ReEvaluateCode.AI_INCONSISTENT, "'within the constraints' contradicted by a verified timeout"
    if RubricCriterion.EXCEEDS_CONSTRAINTS in wanted and not verified_timeout:
        if large_input_pass:
            return ReEvaluateCode.AI_INCONSISTENT, "'exceeds the constraints' contradicted by a passed large-input test"
        return ReEvaluateCode.EXECUTION_UNCERTAIN, "'exceeds the constraints' without a verified timeout"
    if RubricCriterion.LESS_EFFICIENT_WITHIN_CONSTRAINTS in wanted:
        return ReEvaluateCode.EXECUTION_UNCERTAIN, "'less efficient than expected' cannot be verified (no expected complexity)"
    return None


def find_contradiction(assessment: AiDsaAssessment, kinds: list[DefectKind], request: DsaEvaluationRequest) -> str | None:
    """None when the assessment is consistent with the execution evidence, else a short reason (never shown with code)."""
    ex = request.execution
    subsets = _subsets(ex)

    # 1. failures explained by the defects (only a CORRECT approach must explain them defect by defect)
    if assessment.approach is Approach.CORRECT and ex.verdict is not Verdict.COMPILE_ERROR:
        for status in {c.status for c in ex.cases} & set(_EXPLAINS):
            if not _EXPLAINS[status] & set(kinds):
                return f"no reported defect can explain the {status.value} results"

    # 2. a compile-level slip in Java / C++ code that compiled
    if request.submission.language in _COMPILED and ex.verdict is not Verdict.COMPILE_ERROR and DefectKind.SYNTAX in kinds:
        return "a syntax defect, but the code compiled"

    # 3. a wrong / missing approach that passes most hidden tests (partial correctness, not a misunderstanding)
    if assessment.approach is Approach.WRONG_OR_MISSING:
        passed, total = _subset(subsets, "hidden") or (ex.passed, ex.total)
        if passed >= 2 and 2 * passed > total:
            return "a wrong or missing approach cannot pass most hidden tests"

    # 4 + 5. statements the execution evidence disproves; infrastructure blamed
    for text in [d.description for d in assessment.defects] + [assessment.reasoning]:
        problem = _text_contradiction(text, ex, subsets)
        if problem:
            return problem
    return None
