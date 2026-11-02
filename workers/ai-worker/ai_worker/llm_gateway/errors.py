"""Provider-neutral errors. Messages here are SAFE to return to callers: they never contain
secrets, prompts, or raw provider payloads."""


class LLMError(Exception):
    status_code = 502
    code = "LLM_PROVIDER_ERROR"
    default_message = "The AI provider failed to process the request."

    def __init__(self, message: str | None = None, *, retry_after: int | None = None):
        super().__init__(message or self.default_message)
        self.message = message or self.default_message
        self.retry_after = retry_after


class LLMNotConfiguredError(LLMError):
    status_code = 503
    code = "LLM_NOT_CONFIGURED"
    default_message = "The AI provider is not configured on this server."


class LLMAuthError(LLMError):
    status_code = 502
    code = "LLM_AUTH_FAILED"
    default_message = "The AI provider rejected the server's credentials."


class LLMRateLimitError(LLMError):
    status_code = 429
    code = "LLM_RATE_LIMITED"
    default_message = "The AI provider's rate limit or quota was reached. Try again later."


class LLMTimeoutError(LLMError):
    status_code = 504
    code = "LLM_TIMEOUT"
    default_message = "The AI provider did not respond in time."


class LLMUnavailableError(LLMError):
    status_code = 503
    code = "LLM_UNAVAILABLE"
    default_message = "The AI provider is temporarily unavailable."


class LLMBlockedError(LLMError):
    status_code = 422
    code = "LLM_BLOCKED"
    default_message = "The AI provider declined to generate content for this input."


class LLMInvalidOutputError(LLMError):
    status_code = 502
    code = "LLM_INVALID_OUTPUT"
    default_message = "The AI provider returned output that did not match the expected format."
