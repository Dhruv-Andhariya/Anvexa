"""Entry point:  uv run python -m app   ->  AAIE worker on AAIE_WORKER_HOST:AAIE_WORKER_PORT (default 127.0.0.1:8020)."""

import sys


def main() -> None:
    from .config import ConfigError, get_settings

    try:
        settings = get_settings()
    except ConfigError as exc:  # the message names the variable, never its value
        print(f"AAIE worker not started: {exc}", file=sys.stderr)
        sys.exit(2)

    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, log_level=settings.log_level.lower())


if __name__ == "__main__":
    main()
