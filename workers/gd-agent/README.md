# gd-agent

| | |
|---|---|
| **Owner** | M18 AI group discussion |
| **Doc modules** | M18 |

Python side of the AI group discussion ([docs/GROUP_DISCUSSION_ROUND.md](../../docs/GROUP_DISCUSSION_ROUND.md)).
Everything here is free and runs locally; settings come from the repo-root `.env`.

| Process | Command | What it does |
|---|---|---|
| GD worker API (port 8010) | `uv run python -m gd_agent api` | `POST /gd/transcribe` (faster-whisper on the CPU, reads the audio chunks the API stored under `GD_STORAGE_DIR`), `POST /gd/evaluate` (Gemini, strict JSON validated with Pydantic, one retry) |
| AI moderator | `uv run python -m gd_agent moderator dev` (`start` in production) | LiveKit Agents worker `gd-moderator`, dispatched by the API when a room locks; follows the live state in the room metadata and speaks with Piper |
| One-time download | `uv run python -m gd_agent download` | Whisper model (`GD_WHISPER_MODEL`, default base) + Piper voice (`GD_PIPER_VOICE`) |

The timeline (phases, timer, topic banner, pauses) lives in the API, so a GD keeps running if the bot drops; only the
spoken announcements are missing then.

| File | |
|---|---|
| `gd_agent/script.py` | What the moderator says per state change, the silence prompt (pure, tested) |
| `gd_agent/moderator.py` | LiveKit agent: joins, publishes its voice track, follows metadata, watches silence |
| `gd_agent/transcribe.py` | Whisper on one recording (chunk files joined in order); only files under the storage folder |
| `gd_agent/evaluate.py` | The rubric prompt, Pydantic model, one retry, Gemini call with fallback models |
| `gd_agent/api.py` | FastAPI routes (optional `GD_WORKER_SECRET`) |

Python 3.12 (`.python-version`; uv downloads it). Native packages are installed as wheels only
(`[tool.uv] no-build-package`); PyAV is pinned below 15 for faster-whisper 1.2.

Tests: `uv run pytest` (script, evaluation + retry, path safety, routes).
