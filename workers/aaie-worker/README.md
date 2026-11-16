# aaie-worker

| | |
|---|---|
| **Owner** | AAIE module owner (D20) |
| **Doc** | [`docs/AAIE/DSA-SQL/README.md`](../../docs/AAIE/DSA-SQL/README.md) (D21, D29, D30, D38; rubric §9.3) |
| **Status** | Phase 1 Step 1 (foundation) + Phase 2 Step 1 (DSA logic band endpoint, **shadow**). No database, no SQL evaluation, no marks, no PASS / FAIL, no NestJS integration yet. |

Python + FastAPI evaluation service of the Anvexa Assessment Intelligence Engine (AAIE) for DSA and SQL rounds.

## Endpoints

| Method + path | Auth | What |
|---|---|---|
| `GET /health` | public | `{"status":"ok","service":"aaie-worker","version":"0.1.0","aiEnabled":<bool>}` |
| `POST /v1/dsa/evaluate` | `x-worker-secret` when `AAIE_WORKER_SECRET` is set | DSA logic band (rubric v1) for one submission |

### POST /v1/dsa/evaluate

Request (camelCase, unknown fields refused, **no candidate identity**):

```json
{
  "requestId": "req-0001-abcd",
  "problem": { "questionId": "q-1", "title": "Two Sum", "statement": "...", "inputFormat": "...", "outputFormat": "...", "constraints": ["2 <= n <= 10^5"] },
  "submission": { "language": "python", "code": "def two_sum(...)...", "codeHash": "<sha256 hex of code>" },
  "execution": { "kind": "SUBMIT", "expectedTotal": 4, "verdict": "failed", "passed": 3, "total": 4,
                 "cases": [{ "caseId": "c1", "hidden": false, "category": "normal", "status": "passed" }],
                 "compileOutput": "" }
}
```

Response (always 200 for a valid request; 422 for an invalid one, without echoing its content):

```json
{
  "requestId": "req-0001-abcd",
  "status": "EVALUATED",
  "logicBand": 75,
  "bandSource": "AI_RUBRIC",
  "approach": "CORRECT",
  "defects": [{ "severity": "MINOR", "kind": "LOGIC", "description": "...",
                "evidence": [{ "lineStart": 4, "lineEnd": 4, "quote": "if target - x in seen:" }] }],
  "reasoning": "...",
  "reEvaluate": null,
  "versions": { "rubricVersion": "logic-rubric-v1", "promptVersion": "aaie-dsa-logic-prompt-v5",
                "policyVersion": "aaie-dsa-logic-band-policy-v4", "model": "<AAIE_LLM_MODEL>", "workerVersion": "0.1.0" }
}
```

Trusted execution metadata (all optional, H6): `execution.runnerFailure` (`RUNNER_UNAVAILABLE`, `RUNNER_BUSY`,
`NETWORK_ERROR`, `SERVICE_TIMEOUT`, `WORKER_CRASH`, `ENVIRONMENT_ERROR`), `execution.runnerOverloaded`,
`execution.limits` (`cpuMs`, `wallMs`, `memoryKb`); per case `timeMs` (CPU), `wallTimeMs`, `memoryKb`, `exitCode`,
`signal`, `runnerStatus` (Piston `RE` / `SG` / `TO` / `OL` / `EL` / `XX`), `exceptionInCandidateCode`.

Decision order:

0. **infrastructure (H6, `services/failure_classifier.py`):** a `runnerFailure`, a runner fault (`internal_error`) →
   `RE_EVALUATE` / `INFRASTRUCTURE_FAILURE` (no AI call, no band);
1. a runner fault (`internal_error`), no test results, `kind` or `expectedTotal` missing, a `SUBMIT` whose listed
   cases do not cover every expected case (`expectedTotal` = `total` = number of cases, at least one hidden), or
   contradictory evidence (verdict / counts / case statuses disagree, duplicate case ids) → `RE_EVALUATE` /
   `EXECUTION_INCOMPLETE` (no AI call, never a lower band). A `RUN` (sample cases only) is not held to the Submit
   coverage rule;
2. every test passed → band **100**, `bandSource: EXECUTION` (no AI call) **only for a verified complete Submit**:
   `kind: "SUBMIT"`, `expectedTotal` = `total` = number of listed cases, at least one hidden case, every case passed.
   A Run, a partial Submit, counts without cases, or a missing `kind` / `expectedTotal` → `RE_EVALUATE` /
   `EXECUTION_INCOMPLETE`;
2b. **every failure attributed from trusted metadata (H6)** before the AI is asked: wrong answer → candidate; compile
   error → candidate unless the compile step timed out; runtime error → candidate only with evidence (memory cap
   reached, a fault signal SIGSEGV / SIGFPE / SIGABRT / SIGBUS / SIGILL, or an exception traced to the candidate's lines
   with a non-zero exit); time limit → candidate only when CPU time ≥ 90 % of the CPU limit and the runner was not
   overloaded. Runner status `XX`, exit 126 / 127, overload → `INFRASTRUCTURE_FAILURE`; anything unproven (wall clock
   hit with idle CPU, an external SIGKILL, no metadata, a failed Run without per-case results) →
   `EXECUTION_UNCERTAIN`. Both are `RE_EVALUATE` with no AI call and no band; the AI never decides the source;
3. **prompt injection (H4, `services/injection_guard.py`):** the problem text, the code (comments, strings, data) and
   the compiler output are untrusted. Text in them that addresses the evaluator (ignore the rules, award 100 / full
   marks, fake `SYSTEM:` / developer messages, chat-template tags, forged data markers, the output-schema field names)
   - also split, spaced, leetspeak, homoglyphs, full-width, zero-width, reversed, ROT13, base64, hex, `\x` / `\u`
   escapes or character-code lists - → `RE_EVALUATE` / `INJECTION_SUSPECTED` before any AI call (human review, no
   band). The prompt keeps trusted data (rules, execution summary) apart from the nonce-delimited untrusted blocks;
   AI not configured → `RE_EVALUATE` / `AI_NOT_CONFIGURED`;
4. Gemini assesses the code as submitted; timeout / unavailable / blocked / invalid → `RE_EVALUATE` (never FAIL, never
   a lower band);
5. a reply that repeats injected instructions or says it followed instructions from the data ("as instructed",
   "the instructions in the code", "full marks") → `RE_EVALUATE` / `INJECTION_SUSPECTED` (H4);
   a reply with corrected code or an actionable fix (`services/leakage_guard.py`, H5 / D21): code blocks, inline code
   that is not the candidate's own (a single operator / identifier is allowed), corrected statements / functions /
   loops / assignments / increments in plain text, prescriptions ("use …", "should be <=", "must be changed",
   "replace … with …", "`<=` would be correct", "< -> <=", "to fix this", "the correct condition is", suggestions)
   or step-by-step instructions → `RE_EVALUATE` / `AI_SOLUTION_LEAKAGE`; the reply is discarded and nothing of it is
   returned or logged. Describing what is wrong and why, mentioning operators / variables and quoting the candidate's
   code stay allowed;
   the reply must pass the strict schema and deterministic checks (`services/rubric_validator.py`): evidence quotes
   verbatim from the cited lines, no code blocks, inline code only when it is the candidate's own text, compile error
   ⇒ a SYNTAX defect, failed tests ⇒ a defect;
   - **severity (H1):** the AI names one rubric criterion per defect (e.g. `SYNTAX_SLIP`, `MISSING_OR_PARTIAL_STEP`);
     severity and kind come from a fixed table in Python (`CRITERIA`). A reply carrying its own severity / kind is
     refused; one mistake reported under two severities of the same kind → `AI_INCONSISTENT`;
   - **duplicates (H2):** defects with the same criterion at the same spot (overlapping lines and one quote contains the
     other) or with the identical quote (≥ 4 characters) on other lines are one mistake: counted once, evidence merged;
   - **execution evidence (H3, `services/evidence_consistency.py`):** with a CORRECT approach every failing status
     must be explainable by a reported defect (a wrong answer not only by efficiency / syntax defects, a crash not only
     by efficiency, a timeout not only by syntax); no SYNTAX defect for Java / C++ code that compiled; a
     WRONG_OR_MISSING approach cannot pass most hidden tests (≥ 2 and > half); the reasoning / descriptions must not
     state what the evidence disproves (wrong test counts, "all tests pass", "every test fails", "fails the hidden
     tests", "compiles" / "does not compile", "the solution is perfect", "no bugs") or blame the execution
     infrastructure. A material contradiction → `RE_EVALUATE` / `AI_INCONSISTENT`, no band. A pass ratio never sets
     an approach or a band;
   - the band is **derived in Python** from the de-duplicated defects (D29); the AI's proposal must match it (or the
     band of its own, duplicated list), else `RE_EVALUATE` / `AI_INCONSISTENT`.

### Efficiency and the 100 % shortcut (H7, decision D-H7 Option A, approved)

The rubric's 100 % row asks for "the expected efficiency", while §9.1 / §9.2 give full logic marks whenever all tests
pass. Approved interpretation: **execution wins.**

- A verified complete Submit that passes every required test gets band **100 %** from execution, without the AI,
  whatever its complexity (O(n) or O(n²) Two Sum alike). Efficiency is enforced by the question's own tests and time
  limits (maximum-size `large_input` tests, D25), not by the AI.
- On failed submissions, efficiency criteria need execution evidence (§8 rule 3, "complexity claims are measured"):
  - `EXCEEDS_CONSTRAINTS` is accepted only with a **verified candidate timeout** (H6: CPU time ≥ 90 % of the CPU
    limit, runner not overloaded) - also as the only defect. Without one → `RE_EVALUATE` / `EXECUTION_UNCERTAIN`;
    when a passed `large_input` test contradicts it → `RE_EVALUATE` / `AI_INCONSISTENT`.
  - `LESS_EFFICIENT_WITHIN_CONSTRAINTS` cannot be verified (no question carries its expected complexity) →
    `RE_EVALUATE` / `EXECUTION_UNCERTAIN`; next to a verified timeout ("within the constraints" is false) →
    `AI_INCONSISTENT`. It never lowers a band.
  - Passing small tests proves nothing about efficiency; no expected complexity or maximum input size is assumed.
- Infrastructure and uncertain timeouts follow H6 and never reach the AI. Rubric percentages, the band rule, the
  50 / 50 split, HR weights and pass rules are unchanged; the policy version is `aaie-dsa-logic-band-policy-v4`.

It never calculates marks, never decides PASS / FAIL or progression, never runs or fixes code, never writes a
database, and never returns code other than verbatim quotes of the submission.

## Configuration

Read from the environment and the repo-root `.env` (real environment variables win).

| Variable | Default | Rule |
|---|---|---|
| `AAIE_WORKER_HOST` | `127.0.0.1` | host name or IP |
| `AAIE_WORKER_PORT` | `8020` | 1–65535 |
| `AAIE_WORKER_SECRET` | *(empty: no check)* | 16–256 visible characters, no spaces; never logged or returned |
| `AAIE_WORKER_LOG_LEVEL` | `INFO` | DEBUG, INFO, WARNING, ERROR |
| `GEMINI_API_KEY` | *(empty)* | shared with the other workers; masked everywhere |
| `AAIE_LLM_MODEL` | **none** | the Gemini model (open decision T1); empty = AI not configured |
| `AAIE_LLM_TIMEOUT_SECONDS` | `60` | 1–300 (provisional, open decision T5); applied to the SDK client and to every request; no automatic retries; a time-out → `RE_EVALUATE` / `AI_TIMEOUT`, never a candidate failure |

## Run and test

```bash
cd workers/aaie-worker
uv sync                      # install
uv run python -m app         # start on http://127.0.0.1:8020
uv run pytest                # tests (Gemini is mocked; no API key needed)
uv run ruff check .          # lint
```

## Layout

```
app/
  main.py                    FastAPI app (create_app), /health, safe 422 handler
  config.py                  Settings + validation (secrets masked)
  security.py                optional x-worker-secret check (constant-time)
  api/evaluation.py          POST /v1/dsa/evaluate
  prompts/dsa_prompt.py      system instruction (rubric v1, rules) + prompt builder (untrusted-data delimiters)
  services/llm_client.py     Gemini client (structured JSON output, safe typed errors, no retries)
  services/gemini_evaluator.py  decision order above
  services/rubric_validator.py  deterministic checks + D29 band rule
  schemas/evaluation.py      shared enums / evidence models
  schemas/dsa_evaluation.py  request, Gemini wire schema, strict AI model, response
tests/                       pytest with a fake AI client (tests/fakes.py)
```
