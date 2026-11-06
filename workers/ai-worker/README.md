# AI worker (Python) — owner: Intern 2

```bash
cd workers/ai-worker
uv sync                      # installs deps into .venv
uv run python -m ai_worker   # http://localhost:8000/docs  (Swagger, auto-generated)
uv run pytest                # tests (never call the real LLM)
uv run ruff check .          # lint
```
Schemas must mirror `packages/contracts` (see `ai_worker/schemas.py`).

## Status
| Endpoint | State |
|---|---|
| `POST /v1/jd/generate` | **Real** — Gemini via `llm_gateway`, prompt `prompts/jd_generate.v4.yaml` (seniority-aware; the API fact-checks each draft) |
| `POST /v1/jd/validate` | Rule-based completeness checks only (no LLM bias/clarity check yet) |
| `POST /v1/resume/screen` | **Real** — M10 + M11: PDF (pypdf) / DOCX (python-docx) text -> Gemini reads it against the approved JD (prompt `prompts/resume_screen.v1.yaml`) -> fixed formula in `ai_worker/scoring/ats.py` gives the explainable score (skills 40, experience 20, projects 20, achievements 10, qualifications 10). Scanned PDF (opens fine, no text) = Gemini reads the page images (prompt `prompts/resume_transcribe.v1.yaml`, first 10 pages), then the transcript is screened the normal way; its `promptVersion` becomes `resume_screen.v1+resume_transcribe.v1` and the `X-Resume-Text-Source` header is `scan` (else `file`). Damaged / password-protected PDF, empty DOCX, or a scan the model cannot read = 422 `RESUME_UNREADABLE` -> HR review |

## Configuration
The repo-root `.env` is loaded at startup no matter which directory you start from (real env vars win).

| Variable | Required | Notes |
|---|---|---|
| `LLM_PROVIDER` | yes | only `gemini` is supported |
| `LLM_MODEL` | yes | any Gemini model id your key can use |
| `GEMINI_API_KEY` | yes | never logged or returned |
| `LLM_TIMEOUT_SECONDS` | no (60) | per provider request |
| `LLM_TRANSIENT_RETRIES` | no (1) | retries on provider 5xx only; 429/quota is never auto-retried |
| `RESUME_SCREEN_BUDGET_SECONDS` | no (80) | total time for one resume; keep it below the API's `ATS_WORKER_TIMEOUT_MS` (100s) |
| `RESUME_OCR_FALLBACK` | no (true) | `false` = a scanned PDF goes straight to HR review instead of being read from its images (one extra Gemini call per scan) |
| `JD_GENERATION_BUDGET_SECONDS` | no (80) | total time for one JD (output retry + provider retries + fallback models); keep it below the API's `AI_WORKER_TIMEOUT_MS` (90s) |

## `/v1/jd/generate`
Body: `JobForm` fields plus an optional `company` (`CompanyProfile`, the profile HR saved in the API) — 422 if
either is invalid. Returns `JdContent`, plus `X-LLM-Model` and `X-Prompt-Version` headers.
The prompt receives the two inputs in separate data tags, `<company_profile>` and `<job_requirements>`;
`aboutCompany` is written only from the profile and is forced to `""` when no `company` is sent.
Invalid model JSON is retried once, then fails — fake content is never returned.

Errors are `{"detail": {"code", "message"}}` with safe messages:

| Status | Code | When |
|---|---|---|
| 503 | `LLM_NOT_CONFIGURED` | provider/model/key missing, or model not available to the key |
| 429 | `LLM_RATE_LIMITED` | rate limit / quota (sets `Retry-After` when Gemini provides it) |
| 504 | `LLM_TIMEOUT` | provider timeout, or the JD time budget ran out |
| 503 | `LLM_UNAVAILABLE` | provider 5xx / overloaded / network error |
| 502 | `LLM_AUTH_FAILED` | key rejected |
| 502 | `LLM_INVALID_OUTPUT` | output failed schema validation twice (e.g. blank summary), empty, or truncated |
| 422 | `LLM_BLOCKED` | provider safety filters declined the input |

## Live test (uses real quota)
```bash
RUN_LLM_INTEGRATION=1 uv run pytest -m integration
```
