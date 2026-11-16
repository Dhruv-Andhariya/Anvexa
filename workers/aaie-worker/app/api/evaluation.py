"""POST /v1/dsa/evaluate - the DSA logic band (Phase 2, shadow). Protected by the optional x-worker-secret.

Always answers 200 with a structured result (EVALUATED or RE_EVALUATE) for a valid request: an AI failure is never an
HTTP error the caller could mistake for a candidate failure. Invalid requests get 422 without echoing their content.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..schemas.dsa_evaluation import DsaEvaluationRequest, DsaEvaluationResponse
from ..security import require_worker_secret
from ..services.gemini_evaluator import evaluate_dsa

router = APIRouter(prefix="/v1/dsa", dependencies=[Depends(require_worker_secret)])


@router.post("/evaluate", response_model=DsaEvaluationResponse, response_model_by_alias=True)
def evaluate(body: DsaEvaluationRequest, request: Request) -> DsaEvaluationResponse:
    return evaluate_dsa(body, request.app.state.llm_client)
