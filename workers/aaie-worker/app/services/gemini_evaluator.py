"""DSA logic band (Phase 2, shadow): one evaluation of one submission.

Order of decisions:
  0. a known infrastructure failure (runner failure, runner fault) -> RE-EVALUATE (INFRASTRUCTURE_FAILURE) (H6);
  1. execution evidence missing, incomplete or contradictory (a runner fault, no test results, `kind` / `expectedTotal`
     missing, a SUBMIT not covering every expected case with hidden ones, verdict / counts / case statuses disagree,
     duplicate case ids) -> RE-EVALUATE, never a lower band, the AI is not asked;
  2. every test passed -> band 100 from EXECUTION only for a verified complete SUBMIT (every expected case listed,
     hidden cases included, all passed); otherwise RE-EVALUATE. The AI is not asked either way (section 9.1);
  2b. a failure not attributable to the candidate from trusted metadata -> RE-EVALUATE (INFRASTRUCTURE_FAILURE or
      EXECUTION_UNCERTAIN), the AI is not asked (H6, services/failure_classifier.py);
  3. untrusted text (code, problem, compiler output) addressed to the evaluator -> RE-EVALUATE (INJECTION_SUSPECTED),
     the AI is not asked (H4); AI not configured -> RE-EVALUATE;
  4. Gemini assesses the code (rubric v1); any AI failure -> RE-EVALUATE, never FAIL, never a lower band (D30);
  5. the reply must pass the strict schema, must not repeat or follow injected instructions (H4), must contain no
     corrected code or fix (H5), and must pass the deterministic checks (H1-H3); the band is derived in Python.

It calculates no marks, decides no PASS / FAIL or progression, runs no code, writes no database, and returns no code
other than verbatim quotes of the submission. Logs carry metadata only (request id, model, outcome).
"""

from __future__ import annotations

import logging

from pydantic import ValidationError

from .. import __version__
from ..prompts.dsa_prompt import PROMPT_VERSION, RUBRIC_VERSION, SYSTEM_INSTRUCTION, TEMPERATURE, build_prompt
from ..schemas.dsa_evaluation import (
    AiDsaAssessment,
    BandSource,
    Defect,
    DsaEvaluationRequest,
    DsaEvaluationResponse,
    EvaluationStatus,
    EvaluationVersions,
    Evidence,
    FailureSource,
    GeminiDsaWire,
    LogicBand,
    ReEvaluateCode,
    ReEvaluateReason,
)
from .failure_classifier import classify_execution
from .injection_guard import scan_reply, scan_request
from .leakage_guard import leakage
from .llm_client import (
    LLMBlockedError,
    LLMClient,
    LLMError,
    LLMInvalidOutputError,
    LLMNotConfiguredError,
    LLMTimeoutError,
    LLMUnavailableError,
)
from .rubric_validator import POLICY_VERSION, check

log = logging.getLogger("aaie_worker.dsa")

SAFE_MESSAGES: dict[ReEvaluateCode, str] = {
    ReEvaluateCode.AI_NOT_CONFIGURED: "The AI evaluation is not configured; the submission must be evaluated again later.",
    ReEvaluateCode.AI_TIMEOUT: "The AI evaluation timed out; the submission must be evaluated again.",
    ReEvaluateCode.AI_UNAVAILABLE: "The AI service was unavailable; the submission must be evaluated again.",
    ReEvaluateCode.AI_BLOCKED: "The AI service declined to evaluate this submission; it must be evaluated again.",
    ReEvaluateCode.AI_INVALID_OUTPUT: "The AI reply could not be used; the submission must be evaluated again.",
    ReEvaluateCode.AI_INCONSISTENT: "The AI reply did not follow the rubric or the test results; the submission must be evaluated again.",
    ReEvaluateCode.INJECTION_SUSPECTED: "The submission contains text addressed to the evaluator, or the AI reply could not be trusted; it must be reviewed.",
    ReEvaluateCode.AI_SOLUTION_LEAKAGE: "The AI reply did not follow the no-fix rule and was discarded; the submission must be evaluated again.",
    ReEvaluateCode.INFRASTRUCTURE_FAILURE: "The execution infrastructure failed (not the candidate's code); the submission must be executed and evaluated again.",
    ReEvaluateCode.EXECUTION_UNCERTAIN: "It could not be established whether a failure was caused by the code or by the execution infrastructure; the submission must be executed and evaluated again.",
    ReEvaluateCode.EXECUTION_INCOMPLETE: "The execution evidence is incomplete, inconsistent or not a verified complete Submit; the submission must be executed and evaluated again.",
}

_ERROR_CODES: list[tuple[type[LLMError], ReEvaluateCode]] = [
    (LLMNotConfiguredError, ReEvaluateCode.AI_NOT_CONFIGURED),
    (LLMTimeoutError, ReEvaluateCode.AI_TIMEOUT),
    (LLMUnavailableError, ReEvaluateCode.AI_UNAVAILABLE),
    (LLMBlockedError, ReEvaluateCode.AI_BLOCKED),
    (LLMInvalidOutputError, ReEvaluateCode.AI_INVALID_OUTPUT),
]


def _versions(model: str | None) -> EvaluationVersions:
    return EvaluationVersions(
        rubric_version=RUBRIC_VERSION,
        prompt_version=PROMPT_VERSION,
        policy_version=POLICY_VERSION,
        model=model,
        worker_version=__version__,
    )


def _re_evaluate(request: DsaEvaluationRequest, code: ReEvaluateCode, model: str | None) -> DsaEvaluationResponse:
    log.info("dsa evaluation", extra={"request_id": request.request_id, "outcome": "RE_EVALUATE", "reason": code.value, "model": model})
    return DsaEvaluationResponse(
        request_id=request.request_id,
        status=EvaluationStatus.RE_EVALUATE,
        logic_band=None,
        band_source=None,
        approach=None,
        defects=[],
        reasoning=None,
        re_evaluate=ReEvaluateReason(code=code, message=SAFE_MESSAGES[code]),
        versions=_versions(model),
    )


def evaluate_dsa(request: DsaEvaluationRequest, llm: LLMClient | None) -> DsaEvaluationResponse:
    ex = request.execution
    # H6: a known infrastructure failure (runner unavailable / busy / crashed, network, service timeout, environment,
    # runner fault) is never a candidate defect: no AI call, no band.
    if ex.runner_failure is not None or ex.has_runner_fault:
        return _re_evaluate(request, ReEvaluateCode.INFRASTRUCTURE_FAILURE, None)
    if ex.total == 0 or ex.is_contradictory or ex.is_missing_or_incomplete:
        return _re_evaluate(request, ReEvaluateCode.EXECUTION_INCOMPLETE, None)

    if ex.all_passed:
        # 100 only from a verified, complete Submit (hidden cases included); a Run, a partial Submit or counts
        # without case evidence prove nothing, and the AI is never asked to stand in for missing execution.
        # D-H7 Option A (approved): when every required test passes, execution wins - efficiency counts as established
        # by execution (the question's own tests ran within the limits), so no efficiency criterion applies here.
        if not ex.is_verified_complete_submit:
            return _re_evaluate(request, ReEvaluateCode.EXECUTION_INCOMPLETE, None)
        log.info("dsa evaluation", extra={"request_id": request.request_id, "outcome": "EVALUATED", "band": 100, "source": "EXECUTION"})
        return DsaEvaluationResponse(
            request_id=request.request_id,
            status=EvaluationStatus.EVALUATED,
            logic_band=LogicBand.B100,
            band_source=BandSource.EXECUTION,
            approach=None,
            defects=[],
            reasoning="Every test case passed; execution proves the logic, so the AI was not asked.",
            re_evaluate=None,
            versions=_versions(None),
        )

    # H6: every failure must be attributed to the candidate from trusted metadata before the AI sees the submission
    # (services/failure_classifier.py); the AI never decides whether an error was the infrastructure's.
    source = classify_execution(ex)
    if source is FailureSource.INFRASTRUCTURE:
        return _re_evaluate(request, ReEvaluateCode.INFRASTRUCTURE_FAILURE, None)
    if source is FailureSource.UNCERTAIN:
        return _re_evaluate(request, ReEvaluateCode.EXECUTION_UNCERTAIN, None)

    # H4: untrusted text addressed to the evaluator -> no AI call, no band (human review). Execution evidence alone
    # (the 100 % shortcut above) cannot be influenced by such text, so it is checked only here.
    if scan_request(request) is not None:
        return _re_evaluate(request, ReEvaluateCode.INJECTION_SUSPECTED, None)

    if llm is None:
        return _re_evaluate(request, ReEvaluateCode.AI_NOT_CONFIGURED, None)

    prompt, _nonce = build_prompt(request)
    try:
        raw = llm.generate_json(system=SYSTEM_INSTRUCTION, prompt=prompt, schema=GeminiDsaWire, temperature=TEMPERATURE)
    except LLMError as exc:
        code = next((c for kind, c in _ERROR_CODES if isinstance(exc, kind)), ReEvaluateCode.AI_UNAVAILABLE)
        return _re_evaluate(request, code, llm.model)
    except Exception:  # noqa: BLE001 - an unexpected client failure is still an AI failure, never a candidate failure
        return _re_evaluate(request, ReEvaluateCode.AI_UNAVAILABLE, llm.model)

    try:
        assessment = AiDsaAssessment.model_validate_json(raw)
    except ValidationError:
        return _re_evaluate(request, ReEvaluateCode.AI_INVALID_OUTPUT, llm.model)

    if scan_reply(assessment):  # H4: the reply repeats or follows instructions found in the data
        return _re_evaluate(request, ReEvaluateCode.INJECTION_SUSPECTED, llm.model)
    if leakage(assessment, request.submission.code) is not None:  # H5: corrected code / a fix -> discarded, never returned
        return _re_evaluate(request, ReEvaluateCode.AI_SOLUTION_LEAKAGE, llm.model)

    result = check(assessment, request)
    if result.problem is not None or result.band is None:
        return _re_evaluate(request, result.problem or ReEvaluateCode.AI_INVALID_OUTPUT, llm.model)

    log.info(
        "dsa evaluation",
        extra={"request_id": request.request_id, "outcome": "EVALUATED", "band": int(result.band), "model": llm.model},
    )
    return DsaEvaluationResponse(
        request_id=request.request_id,
        status=EvaluationStatus.EVALUATED,
        logic_band=result.band,
        band_source=BandSource.AI_RUBRIC,
        approach=assessment.approach,
        defects=[
            Defect(
                severity=d.severity,
                kind=d.kind,
                description=d.description,
                evidence=[Evidence(line_start=e.line_start, line_end=e.line_end, quote=e.quote) for e in d.evidence],
            )
            for d in result.defects  # severity / kind from the rubric (H1), duplicates merged (H2)
        ],
        reasoning=assessment.reasoning,
        re_evaluate=None,
        versions=_versions(llm.model),
    )
