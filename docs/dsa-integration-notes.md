# DSA coding assessment — integration notes

Isolated DSA assessment module for HireFlow: candidate route `/dsa/[token]` in `apps/candidate-app`, backend module `apps/api/src/modules/dsa`, code execution through the local self-hosted Judge0 CE.

> **Update 2026-11-02: wired to the round engine.** Sections 4 and 6 below describe the plan; this is what was built.
>
> - **Which rounds:** a job round with only Coding questions and a score pass rule (`isCodingRound`, round-engine `online-test.ts`). Passing the round before it queues an invitation (instead of the "HR will contact you" email). Students who already got that email for a coding round are invited by the worker (`clearedBeforeCodingRound`).
> - **Link:** the round engine's own invitation token, emailed as `DSA_SITE_URL/dsa/<token>` (or `DSA_URL` with `{token}`). Same rules as the aptitude link: only its SHA-256 is stored, valid `ASSESSMENT_LINK_DAYS`, withdrawn by HR at once, held while the link is not public. A coding link does not open the MCQ page and the reverse.
> - **Bridge:** `dsa/integration/round-engine.bridge.ts` is the `InvitationResolver`, `SessionStore` and `AssessmentLifecycle`. The timer start creates the round attempt (deadline = HR's time limit, 60 min if none); finish, time-out or an integrity end finishes it; an abandoned attempt is finished by the worker at its deadline.
> - **Grading:** the best score per problem (as before), scaled to HR's round (marks rounded down, never up) and judged by `assessments/grading.ts` against HR's pass rule. The per-problem summary is stored as the result's notes for HR.
> - **Persistence:** table `dsa_sessions` (migration `20261102120000_dsa_sessions`), keyed by invitation id, without the token or the code. The run/submit `BUSY` guard is now a per-process set in `DsaService`.
> - **Questions:** still the 3 built-in problems for every student: HR's coding questions have text only, no test cases (§3 decision still open).
> - **Code runner:** `JUDGE0_URL` etc. Hosted Judge0 CE on RapidAPI is supported (`JUDGE0_RAPIDAPI_HOST`, `JUDGE0_AUTH_HEADER=X-RapidAPI-Key`); each submission and each poll is one request against the plan's quota (`DSA_JUDGE0_POLL_INTERVAL_MS`).
> - **Public link:** `scripts/start-public.ps1` starts a second quick tunnel to the candidate app (:3001) and writes `DSA_SITE_URL`, **only while `JUDGE0_URL` is set** (otherwise every student would be graded 0 and rejected). The candidate app calls the API through its own origin (`/api/v1`, `next.config.ts` rewrite).
> - **Not yet:** DSA proctoring events stay in memory (lost on restart, not shown on the HR round panel); demo tokens no longer work in the app (tests still use `DemoInvitationResolver`); no rate limit on the DSA routes.

> **Status in one paragraph.** The module is complete and verified everywhere except one place: **live code execution through Judge0 could not be verified, because the local Judge0 sandbox cannot run code on this machine** (root cause in [§5](#5-judge0-configuration-and-the-current-blocker)). The backend talks to Judge0 correctly (a submission is accepted, queued and picked up by a worker); the worker then fails inside the `isolate` sandbox. All execution, scoring and UI behaviour was verified against locally installed toolchains instead, which is *not* a substitute for a Judge0 run. Until the Judge0 environment is fixed, the API reports a runner error and scores 0. It never fakes a pass.

> **Read this first (added when the module was moved into this repo).** The module was built and tested in a sandbox copy that did not have the real API's guards. When it was ported here, these changes were made, and a test (`apps/api/tests/dsa-access.test.ts`) runs the DSA routes behind the real `AuthGuard` to prove them:
>
> - **Access is declared.** The global `AuthGuard` answers 403 to any route that does not declare its access. The candidate controllers are `@Public()` (the invitation token is the only credential, validated on every call). The proctoring admin routes are also `@Public()` **but closed by default**: they answer 404 unless `DSA_ADMIN_API_KEY` is set, and then need it in `x-dsa-admin-key`. They deliberately do **not** use `@RequirePermission` yet, because an invitation carries no company (tenant) id, so a session-based check could not stop one company's HR user from listing another company's flagged candidates. Add `tenantId` to the invitation, then switch to `@RequirePermission('jobs.read')` and filter every query by the session's company.
> - **CSRF header.** The guard requires `x-requested-with: hireflow` on every write, even on public routes. `apps/candidate-app/src/lib/dsa-api.ts` sends it on every POST.
> - **Demo tokens are development-only.** `demo-dsa-token` and `demo-dsa-short` resolve only when `NODE_ENV` is not `production` (or `DSA_ALLOW_DEMO_TOKENS=on`). Without a real `InvitationResolver`, a production API therefore rejects every token instead of offering free code execution.
> - **Not wired yet:** per-IP rate limiting (the round-engine uses `rateLimit('assessment')` from `modules/applications`; the DSA routes should get an equivalent), the real `InvitationResolver`, the HR question bank, persistent sessions and proctoring storage, and tenant scoping of HR reports.
> - **Registration:** one import and one entry in `apps/api/src/app.module.ts`. **`apps/candidate-app`** was an empty folder (`.gitkeep`); it now holds a Next.js 15 app, and `pnpm-lock.yaml` gained only that app's entry (32 added lines, none removed). Run `pnpm install` after pulling. Port 3001 is its dev port.
> - **Tests:** `pnpm --filter api test` runs the fast DSA tests. The two slow suites are opt-in: the local-toolchain suite with `DSA_SLOW_TESTS=on` (about 5 minutes, needs Python, Java and g++), and the live Judge0 suite, which skips itself loudly when Judge0 cannot execute code (§5).

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
| `judge0/judge0.client.ts` | Judge0 REST client (batch submit, polling, error normalisation). |
| `evaluation/harness.ts` | Wraps candidate code into a stdin-driven program per language. |
| `evaluation/evaluator.ts` | Runs cases, compares output, redacts hidden-case details. |
| `session/session.store.ts` | `SessionStore` interface and in-memory implementation. |
| `session/invitation.resolver.ts` | `InvitationResolver` interface and demo implementation. |
| `README.md` | Module ownership note (matches the other module folders). |

Tests, under `apps/api/tests/`: `dsa-unit.test.ts`, `dsa-http.e2e.test.ts`, `dsa-judge0.integration.test.ts`, `dsa-local-runner.test.ts`, `dsa-fixtures.ts`, `support/execution-suite.ts`, `support/local-runner.ts`.

Modified (the only shared file touched):

- `apps/api/src/app.module.ts`: **one import line and one entry in `imports`** (`DsaModule`). Needs review by whoever owns the file. Nothing else in `apps/api` was changed.

### Candidate app (`apps/candidate-app`)

Created: `src/lib/dsa-api.ts` (typed client), `src/components/ui.tsx` (Button, Badge, Card, Spinner, `inputClass` — copied from `apps/hr-dashboard/src/components/ui.tsx`), `src/app/favicon.ico` (copy of the HR dashboard's), and under `src/app/dsa/[token]/`: `assessment.tsx`, `problem-panel.tsx`, `code-editor.tsx`, `results-panel.tsx`, `screens.tsx`.

Modified: `src/app/dsa/[token]/page.tsx` (rewritten, now a thin server component), `src/app/layout.tsx` (header in the HR dashboard's style), `src/app/globals.css` (added the HR dark-mode token block and a mono font token; light tokens were already identical).

Deleted: `src/lib/questions.ts` and `src/lib/public-questions.ts`. They were an earlier mock that shipped **hidden test cases inside client code**, which violates the requirement. Nothing referenced them after the page rewrite.

### Not touched

`round-engine`, `rounds-config`, `proctoring`, `notifications`, the HR dashboard, `packages/*`, Prisma schema, `.env.example` (it already lists `JUDGE0_URL`). `pnpm install --frozen-lockfile` was run in `hireflow-dsa-work` because its `node_modules` was broken (no `.bin`); no dependency was added or upgraded, and the lockfile is unchanged. `packages/contracts` was built (`dist/`), as turbo's `^build` would do.

### Outside the repository

The developer's local Judge0 folder (`judge0.conf`, not part of this repo): `REDIS_HOST=redis` → `REDIS_HOST=judge0-v1131-redis-1`, applied with your approval; backup at `judge0.conf.bak-before-redis-host-fix`. The Judge0 server and workers containers were restarted. See §5.

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
| 503 | `JUDGE0_UNAVAILABLE` | Judge0 unreachable or rejecting requests. No URL or token in the message. |

### Behaviour worth knowing

- **Timer:** the deadline is `start + duration`, computed and enforced on the server. A finished-by-expiry state is detected lazily on the next request. The browser countdown is display only (it syncs to `serverTime`); at zero it asks the server.
- **Scoring:** `marks × passed / total`, over sample and hidden tests together (rounded to 2 decimals). The best submission per question counts.
- **Never passes without verification:** a case passes only if the program ran and printed a result that matches the expected output. No output, a crash, a timeout or a runner error is never a pass.
- **Python syntax errors:** Python has no compile step, so Judge0 reports them as runtime errors. When every run dies with a real interpreter `SyntaxError`/`IndentationError`, the API reports `compile_error`.
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

## 4. Connecting the existing invitation token

The route `/dsa/[token]` already matches the shape of an emailed link: `https://<candidate-app>/dsa/<token>`. The page reads `token` and sends it to the API unchanged.

Backend seam: `InvitationResolver.resolve(token): Promise<{ token, assessmentId, candidateName, durationMinutes } | null>` (`session/invitation.resolver.ts`). The current `DemoInvitationResolver` accepts only:

- `demo-dsa-token`: 60 minutes (override with `DSA_DEMO_DURATION_MINUTES`)
- `demo-dsa-short`: 1 minute, for checking timer expiry by hand

To integrate, implement the interface on top of the existing token validation owned by round-engine / the invitation workflow (return `null` for unknown, expired or already-used tokens; map the invitation to an `assessmentId` and a duration from rounds-config), then swap it in `dsa.module.ts` (`DSA_INVITATION_RESOLVER`). No change to the controller, service or UI is needed.

Also required for production:

- **Session persistence:** `SessionStore` is in-memory; state is lost on API restart. Implement it on Prisma (suggested table `dsa_sessions` keyed by token, with `progress` as JSON) and bind `DSA_SESSION_STORE`. The per-candidate `busy` flag would then need a lock or a DB column.
- **CORS:** `apps/api/src/main.ts` allows only `localhost` origins. A deployed candidate-app origin needs adding by the owner of that file.
- **Candidate app → API URL:** `NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api/v1`) is baked in at build time.

---

## 5. Judge0 configuration and the current blocker

### What the backend needs

| Env var | Default | Notes |
|---|---|---|
| `JUDGE0_URL` | `http://localhost:2358` | Server-side only; never sent to the browser. |
| `JUDGE0_AUTH_TOKEN` | unset | Sent in `JUDGE0_AUTH_HEADER` (default `X-Auth-Token`) if the instance has `AUTHN_TOKEN` set. Currently unset on the instance. |
| `JUDGE0_LANG_PYTHON` / `_JAVA` / `_CPP` | `71` / `62` / `54` | Python 3.8.1, Java OpenJDK 13.0.1, C++ GCC 9.2.0. |
| `DSA_CPU_TIME_LIMIT_SEC` | `3` | Per test; the instance maximum is 15. |
| `DSA_WALL_TIME_LIMIT_SEC` | `10` | Per test. |
| `DSA_MEMORY_LIMIT_KB` | `256000` | Per test; instance maximum 512000. |
| `DSA_JUDGE0_POLL_TIMEOUT_MS` | `60000` | Give up waiting after this long. |

Judge0 features used: `POST /submissions/batch?base64_encoded=true` and `GET /submissions/batch?tokens=...`. Both are enabled on this instance (`enable_batched_submissions`).

### Root cause: Judge0 cannot execute code here (two layers)

Judge0 1.13.1 at `localhost:2358` answers `/about` and `/languages`, but every submission failed.

**Layer 1: fixed (with your approval).** Every submission returned HTTP 500 (`Redis::CommandError: ERR AUTH <password> called without any password configured`). The Judge0 server container is attached to two Docker networks, `hireflow_default` (manually, alias `judge0`) and its own `judge0-v1131_default`. On the HireFlow network the hostname `redis` resolves to **HireFlow's own password-less Redis** (`hireflow-redis-1`), not Judge0's password-protected one. Judge0 sent `AUTH`, and the wrong Redis rejected it. Fix applied: `REDIS_HOST=judge0-v1131-redis-1` in `judge0.conf` (a name that is unique), then restarted the server and workers. Submissions are now accepted and picked up.

**Layer 2: open.** Workers now fail every job with status 13, `No such file or directory @ rb_sysopen - /box/script.py`. The sandbox cannot initialise:

```
$ docker exec judge0-v1131-workers-1 isolate --cg --init
Failed to create control group /sys/fs/cgroup/memory/box-0/: No such file or directory
```

Docker Desktop runs **cgroup v2** (kernel `6.18.33.2-microsoft-standard-WSL2`; `/sys/fs/cgroup` is `cgroup2fs`). Judge0 1.13.1 bundles `isolate` 1.8.1, which only supports **cgroup v1** and is always started with `--cg`. In this WSL2 kernel, `/proc/cgroups` lists no `memory` controller at all, so v1 memory cgroups are not available. Setting `kernelCommandLine = systemd.unified_cgroup_hierarchy=0` in `.wslconfig` would therefore probably **not** help on its own. The compose file already uses `cgroup: host` and the image `mrkushalsm/judge0:latest`, which looks like an earlier attempt at this problem; the backup compose file used `judge0/judge0:1.13.1`.

Options for whoever owns the Judge0 setup (none were applied, because each changes the image, the sandbox or the WSL kernel):

1. Run a Judge0 build whose `isolate` supports cgroup v2 (isolate ≥ 2.0 / a cgroup-v2 patched Judge0 image).
2. Run Judge0 on a Linux host or VM with cgroup v1 (or a WSL2 kernel built with `CONFIG_MEMCG_V1`).
3. Dev only: wrap `isolate` to drop `--cg`/`--cg-mem`. This runs code but **loses memory/CPU accounting** and weakens the sandbox, so it should not be used for real candidates.

Once Judge0 can execute, run `pnpm --filter api exec vitest run tests/dsa-judge0.integration.test.ts`. The 38 live tests then un-skip automatically (the suite probes with a real execution, not just `/about`).

---

## 6. Integration points with teammate-owned modules (documented, not implemented)

| Module | What is needed | Where it plugs in |
|---|---|---|
| **round-engine** | Create the DSA invitation/token and call into this module to start a round and read the final result. | Implement `InvitationResolver`; read results via `DsaService.getState(token).result` (or a small exported result port); a finished assessment should notify the round engine so the next round can proceed. |
| **rounds-config** | Duration, question set and pass mark per job/round. | `InvitationResolver` returns `durationMinutes` and `assessmentId`; `QuestionRepository` reads the question set. |
| **proctoring** | Browser signals (tab switches, focus loss, paste, camera) during the assessment. | Frontend hook points: `assessment.tsx` already listens to `visibilitychange`; start/finish transitions are in `DsaService.start/finish`. Backend events (e.g. `dsa.started`, `dsa.submitted`, `dsa.finished`) should be defined in `packages/contracts` by their owner and emitted from `DsaService`. Nothing proctoring-related was built here. |
| **notifications** | Email the result / "assessment completed". | Triggered by the finish event above; this module sends no email. |
| **contracts** | Shared types. | `apps/candidate-app/src/lib/dsa-api.ts` mirrors the DSA response types by hand; move them to `packages/contracts` if you want one source of truth. |

---

## 7. Tests executed and their actual results

Run from `hireflow-dsa-work`, last run on 2026-11-02.

| Check | Command | Result |
|---|---|---|
| Candidate-app type check | `pnpm typecheck` (apps/candidate-app) | **Passed**, no errors |
| Candidate-app production build | `pnpm build` | **Passed** (`/dsa/[token]` 7.08 kB, first load 110 kB) |
| API type check | `pnpm typecheck` (apps/api) | **Passed**, no errors |
| API build | `pnpm build` | **Passed** |
| API test suite | `pnpm test` (apps/api) | **5 files passed, 1 skipped. 82 tests passed, 38 skipped, 0 failed** |

Breakdown of the API suite:

| File | Tests | What it proves | Result |
|---|---|---|---|
| `resume-score.test.ts`, `jd-generation.test.ts` | 4 + 11 | Pre-existing tests, unaffected. | passed |
| `dsa-unit.test.ts` | 27 | Question data (3 questions, marks, tests); hidden data absent from the public projection; exact/float comparison; harness helpers; request validation; service: start/timer with a fake clock, expiry, finish lock, scoring and best-score, never-pass-without-output, compile errors, Judge0 outage → 503 without leaking URL/token, concurrency (BUSY); Judge0 client with a fake `fetch` (base64, auth header, ordering, polling, status mapping, timeouts). | passed |
| `dsa-http.e2e.test.ts` | 2 | Real Nest controllers over real HTTP: full flow for all 3 questions (correct + wrong submissions, run, finish, 60/60), and **every response body scanned: no hidden input/output; hidden cases expose only `id,label,hidden,status,timeMs,memoryKb`**. | passed |
| `dsa-local-runner.test.ts` | 38 | End-to-end through harness → evaluator → scoring for **all 3 questions × Python, Java, C++**: correct solution passes every sample + hidden test; wrong solution is judged failed with a partial score; Run executes samples only; compile/syntax error, runtime error and infinite loop (time limit) in each language; debug prints don't corrupt results; final score aggregation. | passed |
| `dsa-judge0.integration.test.ts` | 38 | Same suite through the **live Judge0**. | **SKIPPED**: the probe reported `Internal Error: No such file or directory @ rb_sysopen - /box/script.py` (§5). **This is not a pass.** |

**Caveat on `dsa-local-runner.test.ts`:** it executes with the toolchains on this PC (Python 3.14, Java 24, MinGW GCC 6.3, no sandbox), so it validates the harnesses, the dataset's expected outputs and the evaluator, not Judge0. Judge0 will use Python 3.8, Java 13 and GCC 9.2; the harnesses use only features available in those versions, but this has not been executed there.

**Browser test** (scratchpad Puppeteer script driving Chrome against the dev server and a test API with the local runner; **not committed to the repo**): 34/34 checks passed on the final code. It covered the intro screen; timer start and countdown; three tabs; language list; starter code; question navigation with code persistence (per question and per language); Run (2/2 samples shown with input, expected and actual); Submit (10/10, hidden rows without details); wrong answer (partial score); Java compile error; reload during the assessment (timer continues from the server, drafts restored); finish confirmation and result screen; invalid-token page; mobile width without horizontal overflow; dark mode; automatic end when the 1-minute timer expires; no console errors; and **14 captured network responses with no hidden test data**. Screenshots were reviewed manually. After that run, one layout-only class change (question tabs on their own row on narrow screens) was made; typecheck and build were re-run afterwards, but the browser script was not.

**Live HTTP check against the real Judge0** (API on port 4100, Judge0 at 2358): start, run and submit return `verdict: "internal_error"`, score 0, with the neutral message "The code runner failed to execute this test", and no hidden data in the responses. Judge0's raw error is logged server-side only.

---

## 7b. Temporary public demo on a Cloudflare quick tunnel

For short-lived testing with a few people, like the aptitude and AI-screening links. **Not a deployment.** The PC must stay on, the URL changes every time `cloudflared` restarts, and code from the testers runs on the host through Judge0 (with the weaker per-process isolation of §7a if the host has no cgroup v1). Share links only with people you trust.

How it is wired: the browser talks only to the candidate app's own origin. `apps/candidate-app/next.config.ts` forwards **only** `/api/v1/dsa/*` to the API (`API_INTERNAL_URL`, baked in at build time). The proctoring admin routes, the rest of the API and Judge0 are not reachable through the tunnel. The link pages send `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and `X-Robots-Tag: noindex`.

1. **Tokens.** The well-known demo tokens are printed in this repo, so do not use them on a public URL. Set `DSA_DEMO_TOKENS` to long random tokens, one per tester (`token:minutes`, minutes optional, default 60; tokens under 16 characters are ignored). While it is set, **only** those tokens work. Each token is one attempt and is used up at Finish or time-out (state is in memory and resets when the API restarts).
2. **API** (`apps/api`): `JUDGE0_URL` (default `http://localhost:2358`), `JUDGE0_PER_PROCESS_LIMITS=true` only if the host has no cgroup v1 (§7a), `DSA_DEMO_TOKENS=...`. Leave `DSA_ADMIN_API_KEY` unset unless you need the HR routes (they are not proxied anyway).
3. **Candidate app** (`apps/candidate-app`): build with `NEXT_PUBLIC_API_URL=/api/v1` and `API_INTERNAL_URL=http://localhost:<api port>/api/v1`, then `next start -p 3001`.
4. **Tunnel:** `cloudflared tunnel --no-autoupdate --url http://localhost:3001`. The link for a tester is `https://<words>.trycloudflare.com/dsa/<token>`.
5. **Check before sharing:** the page opens, a Python run passes on Judge0, `/api/v1/dsa-admin/...` and `/api/v1/health` answer 404 on the public URL, and `demo-dsa-token` is rejected.
6. **Stop:** end the `cloudflared` process (the URL dies at once), then the candidate app and the API.

The `cloudflared` binary used for the first demo was downloaded from Cloudflare's GitHub release, checked against the digest GitHub publishes for that asset, and has a valid Cloudflare, Inc. code signature.

---

## 7a. Update: Judge0 on this PC (dev-only workaround) and the production setup

> **The configuration in this section is for local development only. It must never be exposed to real candidates or public traffic.**

### What was done on this machine

Judge0 1.13.1's isolate sandbox needs cgroup v1, which this PC's Docker Desktop (WSL2 kernel 6.18, cgroup v2, no v1 memory controller) does not have (§5, layer 2). Reading Judge0's `isolate_job.rb` showed a supported alternative: when a submission sets **both** `enable_per_process_and_thread_time_limit` and `enable_per_process_and_thread_memory_limit`, Judge0 does not pass `--cg` and uses plain per-process limits (`isolate -m` / `-t`). No container, binary or Docker volume was modified for this. Changes made:

| Where | Change |
|---|---|
| Backend (opt-in) | `JUDGE0_PER_PROCESS_LIMITS=true` makes the Judge0 client send those two flags. **Default off**, so the cgroup path stays the default. `DSA_JAVA_PER_PROCESS_MEMORY_LIMIT_KB` (default 8,000,000) sets Java's address-space cap in this mode. |
| `judge0.conf` (outside the repo) | `MAX_MEMORY_LIMIT=8000000`. A JVM reserves GBs of *virtual* memory up front, and the compile step takes its cap from this server-wide value, so Java could not compile under the default 512 MB. Backups: `judge0.conf.bak-before-redis-host-fix`, `judge0.conf.bak-before-max-memory`. Judge0 server and workers were restarted. |
| Backend robustness | Polling now retries transient failures up to 3 times; request timeout is configurable (`DSA_JUDGE0_REQUEST_TIMEOUT_MS`, default 30 s). |

Behaviour in this mode: **memory is an address-space cap, not an accounted RSS limit** (Java's cap is nominal, ~8 GB of address space); CPU and wall-clock limits still apply; there is no cgroup accounting. That is acceptable for trusted local testing and **not** for untrusted candidate code.

### Results on this PC (actual)

- Direct Judge0 submissions with real output: Python (`5`), C++ (`5`), Java (`5`, 6 of 6 repeated runs, about 1.2 to 1.5 s each).
- Live suite `dsa-judge0.integration.test.ts` (38 tests), two full runs: **22 passed / 16 failed** before the polling retry fix and **20 passed / 18 failed** after. A Python-only subset passed 10 of 12. The failures were timeouts and "runner not reachable", not wrong answers. They are consistent with an overloaded machine (3.7 GB VM, load average 9 to 13, 18 Judge0 worker processes, JVM runs) but that was **not proven**. Java and C++ are not demonstrated as reliable through Judge0 on this PC. Python is.
- Real Run and Submit through Judge0 (Python) passed in the browser tests of the assessment and of the proctoring change.
- After a Docker restart the Judge0 **server and workers containers did not come back by themselves** (exit code 127, cause not found); `docker start judge0-v1131-server-1 judge0-v1131-workers-1` restored them.

### Production setup: proper CPU and memory isolation

Run Judge0 where its sandbox works as designed, and leave `JUDGE0_PER_PROCESS_LIMITS` **off**:

1. **Host:** a dedicated Linux host or VM (not Docker Desktop, not WSL2) with **cgroup v1** (for Judge0 1.13.x: kernel started with `systemd.unified_cgroup_hierarchy=0`, or an OS image that still defaults to v1). A Judge0 release whose `isolate` supports cgroup v2 is an alternative, but check that it exists and is maintained before depending on it.
2. **Isolation:** keep isolate's cgroup mode (CPU time accounting and an enforced memory limit per run), `privileged: true` only on the Judge0 *workers/server* containers as Judge0 requires, with the host dedicated to this job. Keep `enable_network: false` (the instance default), the instance's `cpu_time_limit`, `wall_time_limit`, `memory_limit` and process limits at the tight defaults, and `max_file_size` small.
3. **Network:** Judge0 reachable only from the API (private network or firewall). Never publish port 2358 to the internet. Set `AUTHN_TOKEN` in `judge0.conf` and `JUDGE0_AUTH_TOKEN` in the API.
4. **Capacity:** size workers to the CPU count (the default spawns many) and test concurrency with the expected number of simultaneous candidates; a single submission batches one run per test case.
5. **Separate Redis:** Judge0 must use its own Redis with a unique hostname (the collision with HireFlow's Redis in §5 came from a shared Docker network alias).
6. **Verify:** run `pnpm --filter api exec vitest run tests/dsa-judge0.integration.test.ts` against it. All 38 tests should run (not skip) and pass.

## 8. Remaining issues and decisions

1. **Judge0 execution is blocked** (§5, layer 2). Needs a cgroup-v2-capable Judge0 or a cgroup-v1 host. Live Judge0 tests exist and will run once fixed; until then Judge0-specific behaviour is verified only against a fake `fetch` (client unit tests) plus the real accept/queue path.
2. **Harness is per problem shape** (§3). Real HR questions need a harness decision.
3. **Sessions are in memory** (§4). Lost on restart; needs a Prisma-backed store. Without a lock, multiple API instances would not share the `busy` guard.
4. **Judge0 compiles once per test case** (one batched submission per case). With a working Judge0 this makes Java/C++ submissions slower than necessary (local runs took roughly 1 to 2 s per Java/C++ test). If that matters, run all cases in one process.
5. **Code editor is a plain textarea** (line numbers, Tab indentation, auto-indent); no syntax highlighting, to avoid adding a dependency. Monaco/CodeMirror can replace `code-editor.tsx` without other changes.
6. **Drafts live in `sessionStorage`** per token (per browser tab session). They are not stored on the server; only submitted code is scored.
7. **Scoring rule:** the best submission per question counts (not the last). Change `DsaService.submit` if the product decision differs.
8. **Environment notes:** `hireflow-dsa-work` is not a git repository, so there is no diff to review; the file lists in §1 are the change record. Ports 3001 and 4000 were in use by other processes, so all testing used 3101 and 4100 and those processes were left alone. Build outputs (`.next`, `dist`, `packages/contracts/dist`) are present in the working folder.
9. **Judge0 config change outside the repo** (§1): needs to be known by whoever owns that Docker setup. The container is also still attached to `hireflow_default`, which is what caused the Redis collision.
