"""Optional shared-secret check for protected routes (same scheme as the GD worker).

When AAIE_WORKER_SECRET is set, the API must send it in the x-worker-secret header; the comparison is constant-time.
/health is never protected. No route uses this yet in Phase 1 - it is the building block for the evaluation routes.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, Request

from .config import Settings


def check_worker_secret(settings: Settings, provided: str | None) -> None:
    """Raises 401 when a secret is configured and `provided` does not match it. The secret is never echoed."""
    if not settings.auth_enabled:
        return
    if not hmac.compare_digest(settings.worker_secret.encode(), (provided or "").encode()):
        raise HTTPException(status_code=401, detail="missing or invalid worker secret")


def require_worker_secret(request: Request, x_worker_secret: str | None = Header(default=None)) -> None:
    """FastAPI dependency for protected routes: uses the settings the app was created with."""
    check_worker_secret(request.app.state.settings, x_worker_secret)
