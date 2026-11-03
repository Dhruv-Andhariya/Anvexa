"""Entry points:
  uv run python -m gd_agent api                 HTTP worker for the API (transcribe + evaluate), port 8010
  uv run python -m gd_agent moderator dev       the LiveKit moderator bot (dev mode; `start` in production)
  uv run python -m gd_agent download            fetch the Whisper model and the Piper voice once
"""

import sys


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "api":
        import uvicorn

        uvicorn.run("gd_agent.api:app", host="127.0.0.1", port=8010)
    elif cmd == "moderator":
        from .moderator import run

        sys.argv = [sys.argv[0], *sys.argv[2:]]  # livekit-agents' own CLI: dev / start / console
        run()
    elif cmd == "download":
        from .config import get_settings
        from .moderator import load_voice
        from .transcribe import _whisper

        load_voice()
        _whisper(get_settings())
        print("Whisper model and Piper voice are ready.")
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
