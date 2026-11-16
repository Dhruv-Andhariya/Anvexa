"""H6: who caused each failed test case - the candidate, the infrastructure, or uncertain.

Decided here, deterministically, from trusted execution metadata only (runner status, signal, exit code, CPU / wall
time, memory, limits, runner state). The AI never decides it: only submissions whose every failure is CANDIDATE reach
the AI. Thresholds are deliberately conservative - when in doubt the answer is UNCERTAIN, which means RE-EVALUATE, never
a lower band.

  - execution-level runner failure (unavailable, busy, network, service timeout, worker crash, environment)
    -> INFRASTRUCTURE for the whole submission;
  - INTERNAL_ERROR status, runner status XX, exit code 126 / 127 (runtime missing / not executable) -> INFRASTRUCTURE;
  - wrong answer -> CANDIDATE (the program ran to the end and its output was compared);
  - compile error -> CANDIDATE, unless the *compile* step timed out (TO) -> UNCERTAIN (may be a slow, loaded runner);
  - runtime error -> CANDIDATE only with reliable evidence: the memory cap reached; a fault signal from the program
    (SIGSEGV, SIGFPE, SIGABRT, SIGBUS, SIGILL); or an exception traced to the candidate's lines with a non-zero exit.
    An external kill (SIGKILL / SIGTERM, exit 137 / 143) without the memory or CPU cap reached, or no evidence at all
    -> UNCERTAIN;
  - time limit -> CANDIDATE only when the program itself used (almost) all of its CPU budget (CPU time >= 90 % of the
    CPU limit) and the runner was not overloaded. Overloaded -> INFRASTRUCTURE (re-run). Wall clock hit with CPU well
    below the limit (waiting: overload, stalled sandbox, or a blocked read) or missing CPU time / limits -> UNCERTAIN.
"""

from __future__ import annotations

from ..schemas.dsa_evaluation import DsaExecution, FailureSource
from ..schemas.evaluation import CaseResult, CaseStatus, RunnerStatus, Verdict

#: A program that used at least this share of its CPU / memory limit reached the limit itself.
LIMIT_SHARE = 0.9
_FAULT_SIGNALS = frozenset({"SIGSEGV", "SIGFPE", "SIGABRT", "SIGBUS", "SIGILL"})
_EXTERNAL_KILLS = frozenset({"SIGKILL", "SIGTERM", "SIGXCPU"})
_ENVIRONMENT_EXIT_CODES = frozenset({126, 127})
_KILLED_EXIT_CODES = frozenset({137, 143})


def _memory_cap_reached(case: CaseResult, ex: DsaExecution) -> bool:
    return ex.limits is not None and case.memory_kb is not None and case.memory_kb >= LIMIT_SHARE * ex.limits.memory_kb


def _cpu_cap_reached(case: CaseResult, ex: DsaExecution) -> bool:
    return ex.limits is not None and case.time_ms is not None and case.time_ms >= LIMIT_SHARE * ex.limits.cpu_ms


def classify_case(case: CaseResult, ex: DsaExecution) -> FailureSource:
    if case.status is CaseStatus.PASSED:
        return FailureSource.CANDIDATE  # nothing failed; never blocks
    if (
        ex.runner_failure is not None
        or case.status is CaseStatus.INTERNAL_ERROR
        or case.runner_status is RunnerStatus.INTERNAL_ERROR
        or case.exit_code in _ENVIRONMENT_EXIT_CODES
    ):
        return FailureSource.INFRASTRUCTURE

    if case.status is CaseStatus.WRONG_ANSWER:
        return FailureSource.CANDIDATE

    if case.status is CaseStatus.COMPILE_ERROR:
        return FailureSource.UNCERTAIN if case.runner_status is RunnerStatus.TIMEOUT else FailureSource.CANDIDATE

    if case.status is CaseStatus.RUNTIME_ERROR:
        if _memory_cap_reached(case, ex) or case.signal in _FAULT_SIGNALS:
            return FailureSource.CANDIDATE
        if case.signal in _EXTERNAL_KILLS or case.exit_code in _KILLED_EXIT_CODES:
            return FailureSource.CANDIDATE if _cpu_cap_reached(case, ex) and not ex.runner_overloaded else FailureSource.UNCERTAIN
        if case.exception_in_candidate_code is True and case.exit_code not in (None, 0):
            return FailureSource.CANDIDATE
        return FailureSource.UNCERTAIN

    if case.status is CaseStatus.TIME_LIMIT:
        if ex.runner_overloaded:
            return FailureSource.INFRASTRUCTURE
        return FailureSource.CANDIDATE if _cpu_cap_reached(case, ex) else FailureSource.UNCERTAIN

    return FailureSource.UNCERTAIN  # an unknown status is never blamed on the candidate


def classify_execution(ex: DsaExecution) -> FailureSource:
    """INFRASTRUCTURE if anything points at the infrastructure, else UNCERTAIN if any failure is unexplained, else
    CANDIDATE. A failed submission without per-case results cannot be attributed and is UNCERTAIN."""
    if ex.runner_failure is not None or ex.verdict is Verdict.INTERNAL_ERROR:
        return FailureSource.INFRASTRUCTURE
    if not ex.cases:
        return FailureSource.CANDIDATE if ex.all_passed else FailureSource.UNCERTAIN
    sources = {classify_case(c, ex) for c in ex.cases}
    if FailureSource.INFRASTRUCTURE in sources:
        return FailureSource.INFRASTRUCTURE
    if FailureSource.UNCERTAIN in sources:
        return FailureSource.UNCERTAIN
    return FailureSource.CANDIDATE
