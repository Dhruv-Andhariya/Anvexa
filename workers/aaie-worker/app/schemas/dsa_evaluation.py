"""Contracts of POST /v1/dsa/evaluate (Phase 2: DSA logic band by AI, shadow).

The request carries the problem context, the submission exactly as the candidate wrote it, and the execution
evidence Piston already produced. It carries **no candidate identity** (no name, e-mail, college): unknown fields are
refused. The response carries a logic band and its evidence - never marks, never PASS / FAIL, never corrected code.
"""

from __future__ import annotations

import hashlib
from enum import IntEnum, StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .evaluation import CaseResult, CaseStatus, Language, SubmissionKind, Verdict, _Model

MAX_CODE_CHARS = 50_000  # same limit as the stored best submission today
MAX_TEXT = 20_000


class LogicBand(IntEnum):
    """Logic rubric v1 (D29): the only values a logic score can take."""

    B100 = 100
    B75 = 75
    B50 = 50
    B25 = 25
    B0 = 0


class EvaluationStatus(StrEnum):
    EVALUATED = "EVALUATED"
    #: The band could not be established reliably (AI unavailable / timed out / invalid output, or the execution
    #: evidence is incomplete). Never FAIL, never a lower band (D30).
    RE_EVALUATE = "RE_EVALUATE"


class BandSource(StrEnum):
    #: Every test passed: execution proves the logic, the AI is not asked (section 9.1).
    EXECUTION = "EXECUTION"
    #: The band was derived in Python from the AI's validated defects (D29, D38).
    AI_RUBRIC = "AI_RUBRIC"


class ReEvaluateCode(StrEnum):
    AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED"
    AI_TIMEOUT = "AI_TIMEOUT"
    AI_UNAVAILABLE = "AI_UNAVAILABLE"
    AI_BLOCKED = "AI_BLOCKED"
    AI_INVALID_OUTPUT = "AI_INVALID_OUTPUT"
    AI_INCONSISTENT = "AI_INCONSISTENT"
    EXECUTION_INCOMPLETE = "EXECUTION_INCOMPLETE"
    #: Untrusted content (code, problem text, compiler output) addresses the evaluator, or the AI reply repeats / follows
    #: such text (H4). Never a band; human review.
    INJECTION_SUSPECTED = "INJECTION_SUSPECTED"
    #: The AI reply contained corrected code or an actionable fix / solution (H5, D21). The reply is discarded.
    AI_SOLUTION_LEAKAGE = "AI_SOLUTION_LEAKAGE"
    #: The runner / network / environment failed (H6): never a candidate defect, never a band.
    INFRASTRUCTURE_FAILURE = "INFRASTRUCTURE_FAILURE"
    #: A failure whose source (candidate or infrastructure) cannot be established from trusted metadata (H6).
    EXECUTION_UNCERTAIN = "EXECUTION_UNCERTAIN"


class FailureSource(StrEnum):
    """Who caused one failed test case, decided deterministically from trusted execution metadata (H6)."""

    CANDIDATE = "CANDIDATE"
    INFRASTRUCTURE = "INFRASTRUCTURE"
    UNCERTAIN = "UNCERTAIN"


class RunnerFailure(StrEnum):
    """A failure of the execution service itself, reported by the caller (H6)."""

    RUNNER_UNAVAILABLE = "RUNNER_UNAVAILABLE"  # Piston not reachable / refused the request
    RUNNER_BUSY = "RUNNER_BUSY"  # queue full / overloaded, the run did not happen
    NETWORK_ERROR = "NETWORK_ERROR"
    SERVICE_TIMEOUT = "SERVICE_TIMEOUT"  # the request to the runner timed out (not the candidate's time limit)
    WORKER_CRASH = "WORKER_CRASH"  # the executing worker / container crashed
    ENVIRONMENT_ERROR = "ENVIRONMENT_ERROR"  # missing language runtime, sandbox set-up failure, ...


class Approach(StrEnum):
    """How the AI reads the overall approach (feeds the D29 band rule)."""

    CORRECT = "CORRECT"  # the approach can solve the problem; defects (if any) are counted
    PARTIALLY_RELEVANT = "PARTIALLY_RELEVANT"  # 25 %: meaningful steps, but cannot solve the problem as stated
    WRONG_OR_MISSING = "WRONG_OR_MISSING"  # 0 %: wrong / irrelevant / empty / unchanged starter / hard-coded


class DefectSeverity(StrEnum):
    MINOR = "MINOR"
    SIGNIFICANT = "SIGNIFICANT"


class DefectKind(StrEnum):
    SYNTAX = "SYNTAX"  # syntax / compile-level slip
    LOGIC = "LOGIC"  # e.g. off-by-one, wrong comparison, wrong initial value, wrong state update
    EDGE_CASE = "EDGE_CASE"  # a missed boundary / edge case (one, or a whole class when SIGNIFICANT)
    EFFICIENCY = "EFFICIENCY"  # MINOR: slower but valid within constraints; SIGNIFICANT: exceeds constraints
    INCOMPLETE = "INCOMPLETE"  # a step missing or only partly implemented


class RubricCriterion(StrEnum):
    """The logic rubric v1 criterion (section 9.3, DSA) a defect meets.

    The AI names the criterion only; the severity and kind follow from it deterministically in Python
    (services/rubric_validator.CRITERIA), so the AI never chooses a severity.

    Efficiency criteria (D-H7 Option A, approved): a complete Submit that passes every test is 100 % from execution,
    so they apply only to failed submissions, and only with execution evidence - EXCEEDS_CONSTRAINTS needs a verified
    candidate timeout; LESS_EFFICIENT_WITHIN_CONSTRAINTS cannot be verified until questions carry their expected
    complexity, so it leads to RE-EVALUATE, never to a lower band (services/evidence_consistency.efficiency_problem).
    """

    # MINOR (75 % row)
    SYNTAX_SLIP = "SYNTAX_SLIP"  # one syntax / compile-level slip (missing bracket, misspelt name)
    LOGIC_SLIP = "LOGIC_SLIP"  # off-by-one, wrong comparison operator, wrong initial value
    MISSED_EDGE_CASE = "MISSED_EDGE_CASE"  # one missed boundary or edge case
    LESS_EFFICIENT_WITHIN_CONSTRAINTS = "LESS_EFFICIENT_WITHIN_CONSTRAINTS"  # slower than expected, still valid
    # SIGNIFICANT (50 % row)
    EDGE_CASE_CLASS_UNHANDLED = "EDGE_CASE_CLASS_UNHANDLED"  # a whole class of edge cases unhandled
    INCORRECT_STATE_UPDATES = "INCORRECT_STATE_UPDATES"  # incorrect state updates
    MISSING_OR_PARTIAL_STEP = "MISSING_OR_PARTIAL_STEP"  # an essential step missing or only partly implemented
    EXCEEDS_CONSTRAINTS = "EXCEEDS_CONSTRAINTS"  # complexity exceeds the problem's constraints


# ------------------------------------------------------------------------------------------------ request


class DsaProblem(_Model):
    question_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=300)
    statement: str = Field(min_length=1, max_length=MAX_TEXT)
    input_format: str = Field(default="", max_length=5_000)
    output_format: str = Field(default="", max_length=5_000)
    constraints: list[str] = Field(default_factory=list, max_length=50)


class DsaSubmission(_Model):
    language: Language
    code: str = Field(max_length=MAX_CODE_CHARS)
    #: SHA-256 (hex) of `code`; checked so evidence always refers to the exact code that was executed.
    code_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def _dsa_language_and_hash(self) -> DsaSubmission:
        if self.language is Language.SQL:
            raise ValueError("SQL queries are not evaluated by the DSA endpoint")
        if hashlib.sha256(self.code.encode("utf-8")).hexdigest() != self.code_hash:
            raise ValueError("codeHash does not match code")
        return self


class ExecutionLimits(_Model):
    """The limits the runner applied (trusted metadata, H6)."""

    cpu_ms: int = Field(ge=1)
    wall_ms: int = Field(ge=1)
    memory_kb: int = Field(ge=1)


class DsaExecution(_Model):
    """The execution evidence Piston produced for this submission (statuses only, no hidden data)."""

    #: Set when the execution service itself failed (H6); then nothing about the candidate can be concluded.
    runner_failure: RunnerFailure | None = None
    #: The runner reported overload (queue / concurrency at its cap) while this submission ran (H6).
    runner_overloaded: bool | None = None
    limits: ExecutionLimits | None = None

    #: RUN (sample cases only) or SUBMIT (sample + hidden cases). Band 100 needs a verified SUBMIT; missing = unverified.
    kind: SubmissionKind | None = None
    #: How many test cases (sample + hidden) the question had when it was submitted. Band 100 needs it to equal `total`,
    #: so a Submit that executed only part of the cases is never treated as complete; missing = unverified.
    expected_total: int | None = Field(default=None, ge=1)
    verdict: Verdict
    passed: int = Field(ge=0)
    total: int = Field(ge=0)
    cases: list[CaseResult] = Field(default_factory=list, max_length=500)
    #: The candidate's own compiler / interpreter message (already shown to the candidate), clipped.
    compile_output: str = Field(default="", max_length=4_000)

    @model_validator(mode="after")
    def _consistent(self) -> DsaExecution:
        if self.passed > self.total:
            raise ValueError("passed cannot be more than total")
        if self.cases:
            if len(self.cases) != self.total:
                raise ValueError("total must equal the number of cases")
            if sum(c.status is CaseStatus.PASSED for c in self.cases) != self.passed:
                raise ValueError("passed must equal the number of passed cases")
        return self

    @property
    def all_passed(self) -> bool:
        return self.total > 0 and self.passed == self.total and self.verdict is Verdict.PASSED

    @property
    def has_runner_fault(self) -> bool:
        return self.verdict is Verdict.INTERNAL_ERROR or any(c.status is CaseStatus.INTERNAL_ERROR for c in self.cases)

    @property
    def is_contradictory(self) -> bool:
        """The verdict, the counts and the case statuses disagree (the API's evaluator never produces this)."""
        if len({c.case_id for c in self.cases}) != len(self.cases):
            return True
        compile_cases = any(c.status is CaseStatus.COMPILE_ERROR for c in self.cases)
        if self.verdict is Verdict.PASSED:
            return self.passed != self.total
        if self.verdict is Verdict.FAILED:
            return (self.total > 0 and self.passed == self.total) or compile_cases
        if self.verdict is Verdict.COMPILE_ERROR:
            return self.passed != 0 or any(c.status is not CaseStatus.COMPILE_ERROR for c in self.cases)
        return False

    @property
    def is_missing_or_incomplete(self) -> bool:
        """`kind` / `expectedTotal` missing, or a SUBMIT whose results do not cover every expected case (hidden included).

        A RUN executes the sample cases only, so it is not held to the Submit coverage rule (it can never reach 100).
        """
        if self.kind is None or self.expected_total is None:
            return True
        if self.kind is SubmissionKind.SUBMIT:
            return not (
                self.cases
                and self.expected_total == self.total == len(self.cases)
                and any(c.hidden for c in self.cases)
            )
        return False

    @property
    def is_verified_complete_submit(self) -> bool:
        """A SUBMIT whose every expected case (including hidden ones) is listed and passed - the only proof for 100."""
        return (
            self.kind is SubmissionKind.SUBMIT
            and self.all_passed
            and not self.is_contradictory
            and self.expected_total is not None
            and self.expected_total == self.total == len(self.cases)
            and any(c.hidden for c in self.cases)
            and all(c.status is CaseStatus.PASSED for c in self.cases)
        )


class DsaEvaluationRequest(_Model):
    #: The caller's id for this evaluation (correlation only; no candidate data).
    request_id: str = Field(pattern=r"^[A-Za-z0-9_-]{8,64}$")
    problem: DsaProblem
    submission: DsaSubmission
    execution: DsaExecution


# ------------------------------------------------------------------------------------------------ AI output
#
# Two models on purpose:
#  - GeminiDsaWire: the lean shape sent to Gemini as response_schema (plain types and string enums only, because the
#    structured-output schema support is narrower than Pydantic's);
#  - AiDsaAssessment: the strict model the raw reply must pass (unknown fields refused, lengths bounded, the band must
#    be one of the five values). A reply that fails it is AI_INVALID_OUTPUT -> RE-EVALUATE.


class _AiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GeminiEvidenceWire(BaseModel):
    line_start: int
    line_end: int
    quote: str


class GeminiDefectWire(BaseModel):
    criterion: RubricCriterion
    description: str
    evidence: list[GeminiEvidenceWire]


class GeminiDsaWire(BaseModel):
    approach: Approach
    defects: list[GeminiDefectWire]
    proposed_band: int
    reasoning: str


class AiEvidence(_AiModel):
    """Where in the submitted code a defect is: a line range and a verbatim quote from those lines."""

    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=500)


class AiDefect(_AiModel):
    #: The only classification the AI makes; a reply carrying its own severity / kind is refused (unknown field).
    criterion: RubricCriterion
    description: str = Field(min_length=1, max_length=500)
    evidence: list[AiEvidence] = Field(min_length=1, max_length=5)


class AiDsaAssessment(_AiModel):
    """The validated AI reply. It has no field for code, fixes, marks or pass / fail."""

    approach: Approach
    defects: list[AiDefect] = Field(default_factory=list, max_length=20)
    #: The band the AI believes applies; Python re-derives it from the defects and requires agreement.
    proposed_band: LogicBand
    reasoning: str = Field(min_length=1, max_length=2_000)


# ------------------------------------------------------------------------------------------------ response


class ReEvaluateReason(_Model):
    code: ReEvaluateCode
    #: Safe, fixed wording - never provider error text, prompts, code or secrets.
    message: str


class EvaluationVersions(_Model):
    rubric_version: str
    prompt_version: str
    policy_version: str
    #: The Gemini model used; null when the AI was not called.
    model: str | None
    worker_version: str


class Evidence(_Model):
    line_start: int
    line_end: int
    quote: str


class Defect(_Model):
    severity: DefectSeverity
    kind: DefectKind
    description: str
    evidence: list[Evidence]


class DsaEvaluationResponse(_Model):
    """No marks, no PASS / FAIL, no progression, no code other than verbatim quotes of the submission."""

    request_id: str
    status: EvaluationStatus
    logic_band: LogicBand | None
    band_source: BandSource | None
    approach: Approach | None
    defects: list[Defect]
    reasoning: str | None
    re_evaluate: ReEvaluateReason | None
    versions: EvaluationVersions
