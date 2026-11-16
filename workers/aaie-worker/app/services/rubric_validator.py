"""Deterministic checks on the AI's assessment, and the D29 band rule (the band is computed here, not taken from AI).

Every AI reply must pass all checks before a band is used; otherwise the result is RE-EVALUATE (D30):
  - evidence: the line range exists and the quote is copied verbatim from those lines of the submitted code;
  - no fixes (D21): checked first by services/leakage_guard.py (H5); this module keeps a defence-in-depth check for
    code blocks and multi-line descriptions;
  - severity (H1): the AI names a rubric criterion only; severity and kind come from CRITERIA here. The same mistake
    reported under two severities is refused (AI_INCONSISTENT) - the worker never picks one itself;
  - duplicates (H2): the same mistake reported more than once counts once (see _same_mistake); its evidence is merged;
  - consistency with execution: a compile error needs a SYNTAX defect; a CORRECT approach with failed tests needs at
    least one defect; no material contradiction with the execution evidence (H3, services/evidence_consistency.py);
  - efficiency (H7, D-H7 Option A): EXCEEDS_CONSTRAINTS only with a verified candidate timeout; an efficiency claim the
    execution contradicts -> AI_INCONSISTENT; an unverifiable one (incl. LESS_EFFICIENT_WITHIN_CONSTRAINTS today) ->
    EXECUTION_UNCERTAIN; never a lower band on the AI's word;
  - the band the AI proposed must equal the band derived here (from the AI's own list, or from the de-duplicated list).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..schemas.dsa_evaluation import (
    AiDefect,
    AiDsaAssessment,
    AiEvidence,
    Approach,
    DefectKind,
    DefectSeverity,
    DsaEvaluationRequest,
    LogicBand,
    ReEvaluateCode,
    RubricCriterion,
)
from ..schemas.evaluation import Verdict
from .evidence_consistency import efficiency_problem, find_contradiction

#: v2: H1 + H2; v3: H3 execution-evidence consistency; v4: H7 efficiency criteria need execution evidence (D-H7, Option A)
POLICY_VERSION = "aaie-dsa-logic-band-policy-v4"
_MAX_REASONING_LINES = 6
#: An identical quote on different lines is "the same mistake repeated" only if it is at least this long (non-space
#: characters), so a bare `i` or `)` never merges two different mistakes.
_MIN_REPEATED_QUOTE = 4

_MINOR, _SIGNIFICANT = DefectSeverity.MINOR, DefectSeverity.SIGNIFICANT

#: Logic rubric v1 (section 9.3, DSA): each criterion has exactly one kind and one severity.
CRITERIA: dict[RubricCriterion, tuple[DefectKind, DefectSeverity]] = {
    RubricCriterion.SYNTAX_SLIP: (DefectKind.SYNTAX, _MINOR),
    RubricCriterion.LOGIC_SLIP: (DefectKind.LOGIC, _MINOR),
    RubricCriterion.MISSED_EDGE_CASE: (DefectKind.EDGE_CASE, _MINOR),
    RubricCriterion.LESS_EFFICIENT_WITHIN_CONSTRAINTS: (DefectKind.EFFICIENCY, _MINOR),
    RubricCriterion.EDGE_CASE_CLASS_UNHANDLED: (DefectKind.EDGE_CASE, _SIGNIFICANT),
    RubricCriterion.INCORRECT_STATE_UPDATES: (DefectKind.LOGIC, _SIGNIFICANT),
    RubricCriterion.MISSING_OR_PARTIAL_STEP: (DefectKind.INCOMPLETE, _SIGNIFICANT),
    RubricCriterion.EXCEEDS_CONSTRAINTS: (DefectKind.EFFICIENCY, _SIGNIFICANT),
}


def _norm(text: str) -> str:
    return " ".join(text.split())


def derive_band(approach: Approach, minor: int, significant: int) -> LogicBand:
    """Logic rubric v1 (D29 + clarification). One SIGNIFICANT plus up to three MINOR defects is 50 %."""
    if approach is Approach.WRONG_OR_MISSING:
        return LogicBand.B0
    if approach is Approach.PARTIALLY_RELEVANT:
        return LogicBand.B25
    if significant > 1 or minor > 3:
        return LogicBand.B25
    if significant == 1 or minor >= 2:
        return LogicBand.B50
    if minor == 1:
        return LogicBand.B75
    return LogicBand.B100


@dataclass(frozen=True)
class ClassifiedDefect:
    """A defect after Python fixed its severity / kind and merged its duplicates."""

    criterion: RubricCriterion
    kind: DefectKind
    severity: DefectSeverity
    description: str
    evidence: tuple[AiEvidence, ...]


@dataclass(frozen=True)
class CheckResult:
    band: LogicBand | None
    problem: ReEvaluateCode | None
    detail: str = ""
    defects: tuple[ClassifiedDefect, ...] = ()


def _same_place(a: AiEvidence, b: AiEvidence) -> bool:
    """Two evidence references point at the same mistake.

    - overlapping lines and one quote contains the other (the same spot, quoted more or less widely); or
    - the identical quote (at least _MIN_REPEATED_QUOTE characters) on other lines: the same mistake repeated.
    Different spots on one line (neither quote contains the other) stay different.
    """
    qa, qb = _norm(a.quote), _norm(b.quote)
    lines_overlap = a.line_start <= b.line_end and b.line_start <= a.line_end
    if lines_overlap and (qa in qb or qb in qa):
        return True
    return qa == qb and len(qa.replace(" ", "")) >= _MIN_REPEATED_QUOTE


def _same_mistake(a: AiDefect, b: AiDefect) -> bool:
    return any(_same_place(x, y) for x in a.evidence for y in b.evidence)


def _classify_and_merge(defects: list[AiDefect]) -> tuple[ClassifiedDefect, ...] | None:
    """Severity from CRITERIA, then de-duplication. None when one mistake carries two severities of the same kind."""
    n = len(defects)
    for i in range(n):
        for j in range(i + 1, n):
            (kind_i, sev_i), (kind_j, sev_j) = CRITERIA[defects[i].criterion], CRITERIA[defects[j].criterion]
            if kind_i is kind_j and sev_i is not sev_j and _same_mistake(defects[i], defects[j]):
                return None

    # union-find over "same criterion and same mistake" (transitive, order-independent groups)
    parent = list(range(n))

    def root(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(n):
        for j in range(i + 1, n):
            if defects[i].criterion is defects[j].criterion and _same_mistake(defects[i], defects[j]):
                parent[root(j)] = root(i)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(root(i), []).append(i)

    merged: list[ClassifiedDefect] = []
    for members in sorted(groups.values(), key=lambda m: m[0]):  # first report order
        first = defects[members[0]]
        evidence: list[AiEvidence] = []
        seen: set[tuple[int, int, str]] = set()
        for k in members:
            for ev in defects[k].evidence:
                key = (ev.line_start, ev.line_end, _norm(ev.quote))
                if key not in seen:
                    seen.add(key)
                    evidence.append(ev)
        kind, severity = CRITERIA[first.criterion]
        merged.append(ClassifiedDefect(first.criterion, kind, severity, first.description, tuple(evidence)))
    return tuple(merged)


def _counts(severities: list[DefectSeverity]) -> tuple[int, int]:
    return severities.count(_MINOR), severities.count(_SIGNIFICANT)


def check(assessment: AiDsaAssessment, request: DsaEvaluationRequest) -> CheckResult:
    code = request.submission.code
    lines = code.split("\n")

    # 1. evidence must point at real lines and quote them verbatim
    for defect in assessment.defects:
        for ev in defect.evidence:
            if ev.line_end < ev.line_start or ev.line_end > len(lines):
                return CheckResult(None, ReEvaluateCode.AI_INVALID_OUTPUT, "evidence outside the submitted code")
            span = _norm("\n".join(lines[ev.line_start - 1 : ev.line_end]))
            if not _norm(ev.quote) or _norm(ev.quote) not in span:
                return CheckResult(None, ReEvaluateCode.AI_INVALID_OUTPUT, "evidence quote not found in the cited lines")

    # 2. no fixes, no new code (D21): checked before this function by services/leakage_guard.py (H5); defence in depth
    #    here, so check() alone never accepts a code block or a multi-line description
    if any("```" in t or "~~~" in t for t in [assessment.reasoning, *(d.description for d in assessment.defects)]) or any(
        "\n" in d.description for d in assessment.defects
    ):
        return CheckResult(None, ReEvaluateCode.AI_SOLUTION_LEAKAGE, "code in the reply")
    if assessment.reasoning.count("\n") >= _MAX_REASONING_LINES:
        return CheckResult(None, ReEvaluateCode.AI_INVALID_OUTPUT, "reasoning too long")

    # 3. severity from the rubric (H1) and de-duplication (H2)
    defects = _classify_and_merge(list(assessment.defects))
    if defects is None:
        return CheckResult(None, ReEvaluateCode.AI_INCONSISTENT, "the same mistake classified with two severities")

    # 4. consistency with the authoritative execution results
    ex = request.execution
    if ex.verdict is Verdict.COMPILE_ERROR and not any(d.kind is DefectKind.SYNTAX for d in defects):
        return CheckResult(None, ReEvaluateCode.AI_INCONSISTENT, "compile error without a SYNTAX defect")
    if assessment.approach is Approach.CORRECT and not ex.all_passed and not defects:
        return CheckResult(None, ReEvaluateCode.AI_INCONSISTENT, "failed tests but no defect reported")
    contradiction = find_contradiction(assessment, [d.kind for d in defects], request)  # H3
    if contradiction is not None:
        return CheckResult(None, ReEvaluateCode.AI_INCONSISTENT, contradiction)
    efficiency = efficiency_problem([d.criterion for d in defects], request)  # H7: efficiency only from execution
    if efficiency is not None:
        return CheckResult(None, efficiency[0], efficiency[1])

    # 5. the band is derived here from the de-duplicated defects. The AI's proposal must agree with the rubric applied
    #    either to that list or to its own list (a proposal that only counted a duplicate twice is not an error).
    band = derive_band(assessment.approach, *_counts([d.severity for d in defects]))
    as_reported = derive_band(assessment.approach, *_counts([CRITERIA[d.criterion][1] for d in assessment.defects]))
    if assessment.proposed_band not in (band, as_reported):
        return CheckResult(None, ReEvaluateCode.AI_INCONSISTENT, "proposed band does not follow the rubric")
    return CheckResult(band, None, defects=defects)
