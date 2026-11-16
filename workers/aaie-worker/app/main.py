"""HTTP side of the AAIE worker:

  GET  /health          -> { status, service, version, aiEnabled }      (public)
  POST /v1/dsa/evaluate -> DSA logic band (Phase 2, shadow)              (x-worker-secret when configured)

No database connection. Settings are validated when the app is created; an invalid setting stops the service before
it accepts any request. Request validation errors never echo the submitted content (candidate code stays private).
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .api.evaluation import router as evaluation_router
from .config import Settings, get_settings
from .schemas.evaluation import HealthResponse
from .services.llm_client import GeminiClient, LLMClient

log = logging.getLogger("aaie_worker")

_DEFAULT = object()


def _llm_from(settings: Settings) -> LLMClient | None:
    if not settings.ai_configured:
        return None
    return GeminiClient(api_key=settings.gemini_api_key, model=settings.llm_model, timeout_seconds=settings.llm_timeout_seconds)


def create_app(settings: Settings | None = None, llm_client: LLMClient | None | object = _DEFAULT) -> FastAPI:
    """`llm_client`: tests pass a fake (or None for "not configured"); by default it comes from the settings."""
    settings = settings or get_settings()
    logging.getLogger("aaie_worker").setLevel(settings.log_level)
    app = FastAPI(title="Anvexa AAIE worker", version=settings.version)
    app.state.settings = settings
    app.state.llm_client = _llm_from(settings) if llm_client is _DEFAULT else llm_client

    @app.exception_handler(RequestValidationError)
    async def _invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # location and message only: never the rejected input (it may contain candidate code)
        errors = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": errors})

    @app.get("/health", response_model=HealthResponse, response_model_by_alias=True)
    def health() -> HealthResponse:
        return HealthResponse(
            service=settings.service_name, version=settings.version, ai_enabled=app.state.llm_client is not None
        )

    app.include_router(evaluation_router)
    log.info(
        "AAIE worker ready (auth %s, ai %s)",
        "on" if settings.auth_enabled else "off",
        "configured" if app.state.llm_client is not None else "not configured",
    )
    return app


app = create_app()
