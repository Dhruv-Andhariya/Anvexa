# DSA coding assessment — integration notes

Isolated DSA assessment module for Anvexa: candidate route `/dsa/[token]` in `apps/candidate-app`, backend module `apps/api/src/modules/dsa`, code execution through a self-hosted **Piston** runner on the hosting PC (see [dsa-piston-hosting.md](dsa-piston-hosting.md)).

> **Status in one paragraph.** The module is **wired into the round engine** as a DSA round of a job's selection process: HR picks bank problems in the rounds editor, students are invited by email after the AI voice screening (or the previous round), take the test on the candidate page with real sandboxed execution on Piston, and the result, the cleared email or the rejection email follow automatically. Sessions, results and the monitoring record are in the database. The whole flow is described in [DSA_ASSESSMENT_ROUND.md](DSA_ASSESSMENT_ROUND.md). Sections below that talk about demo tokens describe the demo mode (`DSA_DEMO_MODE=on`). Judge0, used in an earlier iteration, was dropped (it could not run on this machine's cgroup v2) and its client code was removed.

---

## 1. Files created and modified

### Backend (`apps/api`)

Created, all under `src/modules/dsa/`:

| File | Purpose |
|---|---|
| `dsa.module.ts`, `index.ts` | Nest module and its one public export. Binds the swappable providers. |
| `dsa.controller.ts` | The 5 candidate endpoints. |
| `dsa.service.ts` | Server-side session, timer, scoring, orchestration. |
| `dsa.dto.ts` | Request validation (`parseCodeRequest`) and the error helper. |
| `questions/question.types.ts` | `DsaQuestion` (internal, has hidden tests), `PublicQuestion` and `toPublicQuestion` (field whitelist). |
| `questions/question.repository.ts` | `QuestionRepository` interface and `DSA_QUESTION_REPOSITORY` token. |
| `questions/mock-question.repository.ts`, `questions/mock-questions.data.ts` | Temporary dataset (3 questions). |
| `execution/code-runner.ts` | `CodeRunner` interface (the engine seam), `CODE_RUNNER` token, result and error types. |
| `execution/piston.runner.ts` | Piston client: language mapping, per-run limits, response mapping, concurrency and queue control. |
| `execution/limiter.ts` | `ConcurrencyLimiter`: global slots, bounded FIFO queue, queue timeout. |
| `evaluation/harness.ts` | Wraps candidate code into a stdin-driven program per language. |
| `evaluation/evaluator.ts` | Runs cases, compares output, redacts hidden-case details. |
| `session/session.store.ts` | `SessionStore` interface and in-memory implementation. |
| `session/invitation.resolver.ts` | `InvitationResolver` interface and demo implementation. |
| `README.md` | Module ownership note (matches the other module folders). |

Tests, under `apps/api/tests/`: `dsa-unit.test.ts`, `dsa-http.e2e.test.ts`, `dsa-piston-runner.test.ts`, `dsa-piston.integration.test.ts` (live), `dsa-piston-load.test.ts` (opt-in), `dsa-local-runner.test.ts`, `dsa-proctoring*.test.ts`, `dsa-fixtures.ts`, `support/execution-suite.ts`, `support/local-runner.ts`.

Modified (the only shared file touched):

- `apps/api/src/app.module.ts`: **one import line and one entry in `imports`** (`DsaModule`). Needs review by whoever owns the file. Nothing else in `apps/api` was changed.

### Candidate app (`apps/candidate-app`)

Created: `src/lib/dsa-api.ts` (typed client), `src/components/ui.tsx` (Button, Badge, Card, Spinner, `inputClass` — copied from `apps/hr-dashboard/src/components/ui.tsx`), `src/app/favicon.ico` (copy of the HR dashboard's), and under `src/app/dsa/[token]/`: `assessment.tsx`, `problem-panel.tsx`, `code-editor.tsx`, `results-panel.tsx`, `screens.tsx`.

Modified: `src/app/dsa/[token]/page.tsx` (rewritten, now a thin server component), `src/app/layout.tsx` (header in the HR dashboard's style), `src/app/globals.css` (added the HR dark-mode token block and a mono font token; light tokens were already identical).

Deleted: `src/lib/questions.ts` and `src/lib/public-questions.ts`. They were an earlier mock that shipped **hidden test cases inside client code**, which violates the requirement. Nothing referenced them after the page rewrite.

### Not touched

`round-engine`, `rounds-config`, `proctoring`, `notifications`, the HR dashboard, `packages/*`, Prisma schema, `.env.example` (the root file still lists `JUDGE0_URL`; it is unused now and the owner of that file should replace it with `PISTON_URL`). `pnpm install --frozen-lockfile` was run in `hireflow-dsa-work` because its `node_modules` was broken (no `.bin`); no dependency was added or upgraded, and the lockfile is unchanged. `packages/contracts` was built (`dist/`), as turbo's `^build` would do.

### Outside the repository

- `infra/piston/` (`piston.env`, `start-piston.ps1`): the runner's settings and an idempotent start/verify script. Piston runs as Docker container `hireflow-piston` with volume `hireflow_piston_data`.
- `apps/candidate-app/next.config.ts`: forwards only `/api/v1/dsa/*` to the API, long proxy timeout, privacy headers.

---

## 2. API endpoints

Base: `/api/v1/dsa/:token`. `:token` is the invitation token. All responses are JSON. Errors use `{ statusCode, code, message }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/:token` | Instructions, timer and progress. Questions are included **only while in progress**. |
| POST | `/:token/start` | Starts the server-side timer. Idempotent. Returns the same shape as GET. |
| POST | `/:token/run` | Executes the code against the **public sample tests only**. Nothing is scored. |
| POST | `/:token/submit` | Judges against sample **and hidden** tests, scores, and keeps the best score per question. |
| POST | `/:token/finish` | Ends the assessment. Returns the same shape as GET, with `result`. |

### Request: run / submit

```json
{ "questionId": "dsa-001", "language": "python" | "java" | "cpp", "code": "..." }
```

Code is limited to 64,000 characters.

### Response: GET / start / finish (`AssessmentState`)

```json
{
  "status": "not_started" | "in_progress" | "finished",
  "candidateName": "Demo Candidate",
  "title": "DSA Coding Assessment",
  "durationMinutes": 60,
  "totalMarks": 60,
  "languages": ["python", "java", "cpp"],
  "overview": [{ "id": "dsa-001", "title": "Two Sum", "difficulty": "Easy", "marks": 10 }],
  "serverTime": "ISO", "startedAt": "ISO|null", "deadlineAt": "ISO|null", "remainingSeconds": 3600,
  "questions": [ /* in_progress only: PublicQuestion[] */ ],
  "progress": [{ "questionId": "...", "attempts": 0, "bestScore": 0, "passed": 0, "total": 0, "language": null, "lastVerdict": null }],
  "result": { /* finished only */
    "reason": "submitted" | "time_expired", "finishedAt": "ISO",
    "totalScore": 40, "maxScore": 60, "percentage": 66.67,
    "questions": [{ "questionId": "...", "title": "...", "difficulty": "...", "marks": 10, "score": 10,
                    "passed": 8, "total": 8, "attempts": 1, "language": "python", "solved": true }]
  }
}
```

`PublicQuestion`: `id, title, difficulty, marks, description, inputFormat, outputFormat, constraints[], samples[{input,output,explanation}], starterCode{python,java,cpp}, sampleTests[{id,input,expectedOutput}], hiddenTestCount`. No hidden input or output.

### Response: run / submit (`RunResponse`, `SubmitResponse` adds `score, maxScore, progress`)

```json
{
  "questionId": "dsa-001", "language": "python",
  "verdict": "passed" | "failed" | "compile_error" | "internal_error",
  "passed": 8, "total": 8, "compileOutput": "", "remainingSeconds": 3500,
  "cases": [
    { "id": "ts-1", "label": "Sample test 1", "hidden": false, "status": "passed", "timeMs": 12, "memoryKb": 3200,
      "input": "...", "expected": "[0,1]", "actual": "[0,1]", "stdout": "", "stderr": "" },
    { "id": "ts-h1", "label": "Hidden test 1", "hidden": true, "status": "wrong_answer", "timeMs": 14, "memoryKb": 3300 }
  ]
}
```

`status` is one of `passed | wrong_answer | runtime_error | time_limit | compile_error | internal_error`. **Hidden cases carry only `id, label, hidden, status, timeMs, memoryKb`.** Their input, expected value, actual value, stdout and stderr stay on the server.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST`, `CODE_TOO_LARGE` | Bad body. |
| 404 | `INVALID_TOKEN`, `UNKNOWN_QUESTION` | Unknown token or question. |
| 409 | `NOT_STARTED` | Run/submit/finish before start. |
| 403 | `TIME_EXPIRED`, `ALREADY_FINISHED` | After the deadline or after finish. |
| 429 | `BUSY` | A run is already executing for this candidate. |
| 503 | `CODE_RUNNER_UNAVAILABLE` | Piston unreachable or rejecting requests. Never reported as a pass. |
| 503 | `CODE_RUNNER_BUSY` | Run queue full or waited too long (`DSA_RUNNER_QUEUE_TIMEOUT_MS`). Try again. |

### Behaviour worth knowing

- **Timer:** the deadline is `start + duration`, computed and enforced on the server. A finished-by-expiry state is detected lazily on the next request. The browser countdown is display only (it syncs to `serverTime`); at zero it asks the server.
- **Scoring:** `marks × passed / total`, over sample and hidden tests together (rounded to 2 decimals). The best submission per question counts.
- **Never passes without verification:** a case passes only if the program ran and printed a result that matches the expected output. No output, a crash, a timeout or a runner error is never a pass.
- **Python syntax errors:** Python has no compile step, so the runner reports them as runtime errors. When every run dies with a real interpreter `SyntaxError`/`IndentationError`, the API reports `compile_error`.
- **Candidate prints:** the harness prints the return value on a marker line, so debug `print`s appear in `stdout` and cannot corrupt the result.

---

## 3. Temporary questions and how to replace them

Three questions in `questions/mock-questions.data.ts`: Two Sum (Easy, 10), Longest Substring Without Repeating Characters (Medium, 20), Median of Two Sorted Arrays (Hard, 30). Each has a description, input and output format, constraints, a sample with explanation, starter code (Python, Java, C++), 2 public tests and 6–8 hidden tests (edge cases, overflow, a 10,007-element and a 50,000-character input).

### Replace the data source

1. Implement `QuestionRepository.findForAssessment(assessmentId): Promise<DsaQuestion[]>` over the HR-configured dataset (Prisma or an HTTP call to the HR module).
2. In `dsa.module.ts` change `{ provide: DSA_QUESTION_REPOSITORY, useClass: MockQuestionRepository }` to your class.
3. Nothing in the UI changes. The UI only consumes `PublicQuestion` from the API.

Field mapping for an HR question → `DsaQuestion`: title, difficulty, marks, description, constraints, samples, starter code per language, test cases (`hidden: true/false`, `stdin`, `expectedOutput`, `display` for public cases).

### Important limitation: how candidate code is wrapped

Candidates write a **function** (LeetCode style). `evaluation/harness.ts` contains one template per problem shape (`HarnessKind`: `two-sum`, `longest-substring`, `median-sorted-arrays`) that reads stdin, calls the function and prints the result. HR questions with a *new* function signature therefore need either:

- a new `HarnessKind` template per signature (cheap, explicit), **or**
- a generic mode: HR stores the function signature plus argument/return types and the backend generates the harness, **or**
- a `stdio` mode where the candidate writes a whole program that reads stdin and prints stdout (no harness; add a `harness: 'stdio'` kind that passes the source through unchanged).

This choice belongs with whoever designs the HR question format. It is the main design decision left before real questions can be used.

stdin format used by the current harnesses: int array → `"<len> v1 v2 ..."` on one line; integer → one line; string → raw line. Comparison is exact (trimmed) or numeric with 1e-5 tolerance (`comparator`).

---

## 4. The invitation token (wired)

The link in the email is `https://<candidate-app>/dsa/<token>`; the token is the round engine's invitation token (32 random bytes, only its SHA-256 stored in `round_invites`). The page sends it to the API unchanged.

Seams, all bound in `dsa.module.ts` (the real implementation is the default; `DSA_DEMO_MODE=on` binds the demo ones):

| Seam | Real | Demo |
|---|---|---|
| `InvitationResolver` | `RoundInvitationResolver`: `RoundEngineService.openCodingRound(token)` checks the link (known, not withdrawn, not expired before the start, the round is still a DSA round) and returns the candidate, the minutes and the round's questions | `DemoInvitationResolver`: `demo-dsa-token` (60 min), `demo-dsa-short` (1 min), or `DSA_DEMO_TOKENS` |
| `QuestionRepository` | `BankQuestionRepository`: the round's bank problems under HR's round-question ids, HR's marks and order | the whole bank |
| `SessionStore` | `EngineSessionStore`: the attempt is the engine's `round_attempts` row; progress in `coding_state`; finishing records the result and queues the next email | in memory |
| `ProctorStore` | `PrismaProctorStore`: table `dsa_proctor_sessions` | in memory |

The demo tokens are refused when `NODE_ENV=production` unless `DSA_ALLOW_DEMO_TOKENS=on`, and `DSA_DEMO_TOKENS` (long random tokens) replaces the two well-known ones.

Still true for production: **CORS** in `apps/api/src/main.ts` allows only `localhost` origins, which does not matter for the candidate app because the browser calls the candidate app itself (same origin) and the app forwards `/api/v1/dsa/*`; and `NEXT_PUBLIC_API_URL` / `API_INTERNAL_URL` are baked in at build time.

---

## 5. Code execution (Piston)

Full hosting, startup and troubleshooting guide: **[dsa-piston-hosting.md](dsa-piston-hosting.md)**. Summary:

- `PistonRunner` implements `CodeRunner` and posts to `${PISTON_URL}/api/v2/execute` (default `http://127.0.0.1:2000`, server-side only, never sent to the browser). Languages: Python 3.12, Java 15, C++ (gcc 10.2).
- Limits per run: wall time, CPU time, memory, set from `DSA_RUN_*`, `DSA_COMPILE_*`, `DSA_JAVA_*`; Piston enforces ceilings from `infra/piston/piston.env`. No network in the sandbox; output capped at 64 KiB.
- Control: `DSA_RUNNER_CONCURRENCY` (3), `DSA_RUNNER_PER_SUBMISSION` (2), `DSA_RUNNER_QUEUE_TIMEOUT_MS` (60000), `DSA_RUNNER_MAX_QUEUE` (60). A refused run is reported as `CODE_RUNNER_BUSY`, never as a pass.
- The evaluator runs the first test case alone, so a compile error is reported once instead of once per case. Compiler diagnostics are rewritten to `solution:N` (the candidate's own line numbers); harness lines show as `solution:?`.
- Java: Piston runs Java in single-file source mode, so the generated `Main` class comes first and the candidate's `import` lines are moved to the top of the file.
- Judge0 history: Judge0 1.13.1 could not initialise its `isolate` sandbox on this PC (it needs cgroup v1; Docker Desktop provides v2) and a per-process-limits workaround was slow and flaky, so it was replaced. Its client, tests and settings were removed from the repository. The machine-level removal of the old Judge0 containers and files is a separate step that needs explicit approval and has not been done.

---

## 6. Integration with the other modules (done)

| Module | How it is connected |
|---|---|
| **round-engine** | A DSA round is a round kind (`roundKind` = CODING). The engine invites, keeps the clock, sweeps overdue attempts, records the result and queues the next invitation or email. The dsa module calls it only through `round-engine/index.ts`. |
| **rounds-config** | HR's rounds editor stores the problem as the topic `dsa:<id>` on a CODING question; the schema refuses unknown problems; duration and pass rule come from the round. |
| **assessments** | `record()` receives marks per problem, `isCorrect`, the best code and a summary; pass or fail is decided in `grading.ts` only. |
| **notifications / email** | The round engine's existing invitation, cleared and rejection emails (coding wording for the invitation). |
| **proctoring** (the older module) | Not used. The DSA page has its own browser monitoring (this module's `proctoring/`); HR reads it through `/dsa-hr`. |
| **contracts** | `schemas/dsa-bank.ts` (bank list, marker rules, `isDsaRound`, the HR review shape). The candidate page's own response types are still mirrored by hand in `apps/candidate-app/src/lib/dsa-api.ts`. |

---

## 7. Tests executed and their actual results

Run from `hireflow-dsa-work`, last run on 2026-11-02, with Piston running (`infra/piston/start-piston.ps1`).

| Check | Command | Result |
|---|---|---|
| Candidate-app type check | `pnpm typecheck` (apps/candidate-app) | **Passed**, no errors |
| Candidate-app production build | `pnpm build` with `NEXT_PUBLIC_API_URL=/api/v1` | **Passed** (`/dsa/[token]` 11.1 kB, first load 114 kB) |
| API type check | `pnpm typecheck` (apps/api) | **Passed**, no errors |
| API build | `pnpm build` | **Passed** |
| API test suite | `pnpm test` (apps/api) | **9 files passed, 1 skipped. 181 tests passed, 1 skipped, 0 failed** (214 s) |

The one skipped test is `dsa-piston-load.test.ts`, which is opt-in (it fires up to 20 simultaneous submissions; see its header). It was run separately, see below. The live Piston suite skips itself automatically when Piston is not reachable, so **a green run without Piston running is not proof**; this run had Piston up (its 38 tests ran).

| File | Tests | What it proves |
|---|---|---|
| `resume-score.test.ts`, `jd-generation.test.ts` | 4 + 11 | Pre-existing tests, unaffected. |
| `dsa-unit.test.ts` | 27 | Question data; hidden data absent from the public projection; comparison; harness helpers (incl. line mapping and Java import hoisting); request validation; service: timer with a fake clock, expiry, finish lock, scoring and best score, never-pass-without-output, compile errors, runner outage and busy mapped to 503 without leaking URLs. |
| `dsa-piston-runner.test.ts` | 21 | Piston client with a fake `fetch`: request shape and limits, language and file names, status mapping (OK, runtime error, signal, timeout, memory kill, Java compile error), noise stripping, unreachable runner, concurrency limiter (slots, queue order, timeout, max queue). |
| `dsa-proctoring.test.ts`, `dsa-proctoring.e2e.test.ts` | 35 + 5 | Proctoring rules, strike policy, admin routes closed by default, over real HTTP. |
| `dsa-http.e2e.test.ts` | 2 | Real Nest controllers over real HTTP: full flow for all 3 questions, and **every response body scanned: no hidden input/output**. |
| `dsa-piston.integration.test.ts` | 38 | **Live Piston**: 3 questions × Python/Java/C++ (correct, wrong, Run), compile error, runtime error and infinite loop per language, debug prints, score aggregation. **38 of 38 passed.** |
| `dsa-local-runner.test.ts` | 38 | Same suite with toolchains installed on this PC (no sandbox). It validates the harnesses, expected outputs and evaluator, not Piston. |

### Load test (opt-in, live Piston, defaults: concurrency 3)

6, 12, 10 Java, 10 C++, 20 mixed and 20 C++ simultaneous submissions: every result correct, none refused. Slowest case: about 113 s for 20 simultaneous C++ submissions. Details in [dsa-piston-hosting.md](dsa-piston-hosting.md) §6.

### Browser tests (scratchpad Puppeteer scripts driving real Chrome; **not in the repo**)

Run against the production build of the candidate app (browser calls the same origin, which forwards `/api/v1/dsa/*`), with the API running on Piston:

- Assessment UI regression: **34 / 34** (intro, timer and server sync, three tabs, language list and starter code, navigation with drafts, Run and Submit, hidden rows without details, wrong answer partial score, Java compile error, reload keeps the timer, finish and result screens, invalid token, mobile width, expiry of a 1-minute assessment, 18 captured responses with no hidden data, no console errors).
- Proctoring: **56 / 56** with `DSA_PROCTOR_MAX_STRIKES=0` (the script deliberately triggers about 19 violations). The scripts' step labels still say "real Judge0"; that text is stale, the runs used Piston.
- Strike policy (2 allowed, third ends the assessment) was verified earlier with its own script (24 checks) before the runner change; **it was not re-run** after the switch to Piston because it does not touch code execution.
- Public URL through a Cloudflare quick tunnel: **11 / 11**, every API call 200, no console errors. Probes through the public URL for `/api/v2/runtimes`, `/api/v1/dsa-admin/*`, `/api/v1/health`, `/api/v1/auth/me`: all 404. Piston published on `127.0.0.1:2000` only. A test from a genuinely separate network was not possible from the hosting PC.

---

## 8. Remaining issues and decisions

1. **HR integration is done** (see [DSA_ASSESSMENT_ROUND.md](DSA_ASSESSMENT_ROUND.md)). Not done: HR-managed problem bank (the three problems are code), a SQL round, a new link for a withdrawn candidate.
2. **Harness is per problem shape** (§3). Real HR questions need a harness decision.
3. **One API instance**: the per-candidate "one run at a time" guard and the runner queue are in memory (sessions and records are in the database). Several API instances would need a shared lock and queue.
4. **Compile cost per test case.** Each test case is its own run, so Java (about 4 to 5 s) and C++ (about 9 to 12 s) submissions are slow, and a burst of C++ submits queues. Running all cases of a submission in one process would cut this a lot (not done).
5. **Cloudflare ~100 s request limit** on its default plan (documented, not verified here) can cut an extreme submit burst even though the result is still computed. Async submit with polling would remove the issue (not done).
6. **Stable public address**: a quick tunnel URL changes on every restart. Links to students need a domain with a named tunnel, or a static ngrok domain.
7. **Teammates cannot use a localhost-only Piston.** They test through the hosted URL or run `start-piston.ps1` themselves. Never expose port 2000 directly (no authentication).
8. **Hosting PC headroom** is small (7.7 GB RAM, 0.6 to 0.7 GB free while testing). See the hosting guide's requirements.
9. **Code editor is a plain textarea** (no syntax highlighting, to avoid a dependency). **Drafts live in `sessionStorage`** per token; only submitted code is scored.
10. **Scoring rule:** the best submission per question counts (not the last).
11. **Old Judge0 install still present on the PC** (containers, volumes, `Downloads` folder and zip). Removal was requested but needs explicit approval of the list shown earlier; nothing was deleted.
12. **Environment notes:** the work was first built in a separate folder (`hireflow-dsa-work`, not a git repository) and then ported into this repository on `develop` as plain file changes; the commit is made by the repository owner.
