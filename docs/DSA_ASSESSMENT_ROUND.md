# DSA coding round

How a DSA (data structures and algorithms) coding test fits into a job's selection process: HR configures it in the
rounds editor, the round engine invites students automatically, students take it in a browser with nothing to
install, and the result decides who moves on and who gets a rejection email.

Code: `apps/api/src/modules/dsa` (candidate page API, problem bank, scoring, proctoring), `apps/api/src/modules/round-engine`
(invitation, clock, result, emails), `apps/careers-site` (the coding page, `/dsa/[token]`, on the same site and port 3300 as every
other candidate round; until November 2026 it was a separate app, `apps/candidate-app` on port 3001). Code execution:
[`dsa-piston-hosting.md`](dsa-piston-hosting.md). Proctoring details: [`PROCTORING.md`](PROCTORING.md) (current reference) and [`dsa-proctoring-implementation.md`](dsa-proctoring-implementation.md) (original browser-proctoring change).
Module notes (questions, harnesses, older Judge0 history): [`dsa-integration-notes.md`](dsa-integration-notes.md).

---

## 1. The flow

```
resume screening ─▶ AI voice screening ─▶  DSA round  ─▶ (next round / HR interview)
 (existing)          COMPLETED               │
                                             ├─ invitation email with a personal link         (round engine, automatic)
                                             ├─ student opens the link, accepts the monitoring notice, presses Start
                                             │     server clock starts · problems appear · Run / Submit on Piston
                                             ├─ Finish, or the time runs out (the server ends it even if the tab is closed)
                                             ├─ result recorded: marks per problem, total, pass or fail by HR's pass rule
                                             └─ email:  passed ─▶ "cleared" (HR will contact you / next round invitation)
                                                         failed ─▶ rejection email
```

A DSA round can be the first round (invited right after the AI voice screening) or come later (invited when the student
passes the previous online round). The same machinery runs the aptitude and English tests; a DSA round is simply a
second kind of online round.

## 2. HR: setting a DSA round up

1. Publish page, rounds step: **Add round**, type **Coding** (a round name HR chooses, e.g. "DSA Coding Round").
2. Add questions of kind **Coding**. For each one, choose the **DSA problem** in the dropdown under the question text:
   - **Write my own problem**: the question text is the statement the student reads. HR adds a title, the input and
     output format, constraints (one per line) and the **test cases**: the input the program reads on stdin and the
     output it must print. At least one test must be a **sample** (shown to the student and used by Run); tick
     **Hidden** for the others (they only grade Submit and never leave the API). Output is compared line by line, spaces
     at the end of a line and blank lines at the end ignored. The student writes a whole program in Python, Java or
     C++ that reads the input and prints the answer (the page gives a starter program). Stored with the question
     (`round_questions.coding_spec`, migration `20261103120000_dsa_hr_problems`).
   - **A bank problem** (Two Sum, Longest Substring Without Repeating Characters, Median of Two Sorted Arrays). Choosing
     one fills in the text, difficulty and the suggested marks; HR may change the marks. The question text is only for
     HR: the student sees the problem statement from the bank.

   Both kinds can be mixed in one round.
3. Set the **time limit** (minutes; empty means 60) and the **passing criterion**, for example *Marks: 25* for a round of
   Easy 10 + Medium 20 + Hard 30 = 60 marks. *Percentage* and *Number of correct answers* (a problem counts as correct
   when every test passes) also work.
4. Mark the rounds **complete**. From then on the round is run online.

A round is run online only when **every** question has a DSA problem and the passing criterion is not an interviewer's
score. A coding question without a problem (HR's own text) keeps the old behaviour: HR runs that round, the engine stops
before it and the student is told HR will be in touch.

The first student who starts locks the questions and the pass rule for the whole job, like every other round.

## 3. What the student gets

- **Email**: "Congratulations! You've Been Shortlisted for <job> – Next Step: DSA Coding Round" (the same "shortlisted"
  email for every round the student moves on to, in the order HR set: aptitude -> DSA -> SQL -> ...): number of problems, minutes, instructions from HR, the
  personal link (valid 7 days from sending, configurable), the rules (laptop or desktop, full screen, Python / Java /
  C++, nothing to install, a working webcam that stays on (checked on the student's device, never recorded), no microphone or screen recording). It never contains marks or the pass mark.
- **Page** (`/dsa/<token>`): start screen with the list of problems (titles, difficulty, marks, no statements); consent
  to the monitoring notice; full screen; then the problems, a code editor, Run (sample tests only, nothing scored) and
  Submit (sample and hidden tests, scored; best score per problem counts). The countdown is the server's. During the
  test the student's own camera preview floats and can be dragged to any of the four corners (or moved with its ⤢
  button); moving it never touches the camera stream or the face check (`CameraTile`, `camera-monitor.tsx`).
- **Submitting near the end**: a Submit is accepted atomically under the attempt's row lock, only while the attempt
  runs and strictly before its deadline on the server clock, one at a time per attempt (a second one gets `429 BUSY`).
  Once accepted, its result is recorded even if the time-out sweep, Finish or a termination closes the attempt
  meanwhile, and grading and the next step wait for it. A code-runner failure releases it (`503`, nothing recorded).
  An accepted submission whose result never arrives is abandoned after 15 minutes (`PENDING_SUBMISSION_MAX_MS`; the
  attempt is graded without it, and a late result is refused with `409 SUBMISSION_NOT_RECORDED`). The student is shown
  a score only after it is stored. After a page reload the state carries `judging: { questionId, acceptedAt }`: the
  page shows "Judging your submission…", holds Submit, and then shows the saved result or an honest "please submit
  again" message (`lib/dsa-judging.ts`). Kept in `round_attempts.coding_state` (`pending`), no schema change. Tests:
  `apps/api/tests/round-engine/dsa-deadline-race.db.test.ts`, `apps/careers-site/tests/dsa-judging.test.ts`.
- **Last page**: "submitted, the hiring team will contact you by email". **No score, no percentage, no pass or fail**
  (`DSA_SHOW_SCORE=on` shows the score if a company wants that).
- Closing the tab does not stop the clock. Reopening the link continues the same attempt with the saved progress. After
  the end the link only shows the end page; a second attempt is not possible.

## 4. Scoring and the decision

- A problem's score is `marks x tests passed / total tests` (sample and hidden tests together); the **best submission** of
  each problem counts; the round total is the sum (never more than a problem's marks).
- Pass or fail is decided in one place only, the assessments module (`grading.ts`), by HR's passing criterion. HR can
  still override it afterwards on the Assessments page, as for any round.
- The result is stored per problem with the best source code and a one-line summary ("3 of 3 tests passed (python), 2
  submissions"), so HR can read what the student wrote.
- **Time ran out**: the attempt is scored with what had been submitted (the engine's worker does this even when nobody
  has the page open, within about 30 seconds of the deadline plus the poll interval).
- **Ended by the warning limit** (code default: 2 warnings, the 3rd confirmed incident terminates; `DSA_PROCTOR_MAX_STRIKES`,
  which a deployment's `.env` may set differently): the attempt becomes `TERMINATED` with integrity status
  `INTEGRITY_VIOLATION_REVIEW`. What was submitted so far is graded (HR sees the score), but **no next step and no email**
  follow until HR records an integrity decision (Advance / Reject, `POST /round-engine/applications/:id/rounds/:roundId/integrity-decision`).
  The student's end screen shows the termination message and no score (`DSA_SHOW_SCORE` default off). Details: [`PROCTORING.md`](PROCTORING.md).
- **Only the code runner's tests score.** Marks and pass / fail come only from the test results (`DsaService.scoreOf`
  -> round engine `coding-round.ts` -> assessments grading). Gemini / AAIE is **not** part of official scoring: the API
  never calls the AAIE worker (`workers/aaie-worker`, shadow / advisory only; integration postponed).
- **Emails after the result** (sent in the background, retried, never twice): passed and another online round follows ->
  that round's invitation; passed and HR runs the next round -> "Congratulations, HR will contact you about <round>";
  passed the last round -> "cleared all rounds"; failed -> rejection. None contains a score.

## 5. What HR sees

- **Assessments page**: the DSA round as a column with score, pass mark and outcome per student (existing page).
- **Student review**: per problem marks, solved or not, the best code.
- **Round engine panel** (student review): "DSA coding test": invitation status, started, time taken, problems submitted,
  withdraw link / send again. **Monitoring record**: status (nothing unusual / warnings used / needs a look / ended by the
  warning limit), counts (full-screen exits, tab switches, copy or paste attempts, developer-tools shortcuts, time away) and the event
  timeline. These are observations, not proof of cheating, and no video, audio, screen or typed text is ever recorded.

## 6. Running it

### One-time setup
1. **Database**: apply the migration `20261102120000_dsa_round` (`pnpm --filter api db:deploy`). It adds `round_attempts.coding_state`
   and the table `dsa_proctor_sessions`; nothing existing changes. Until it is applied the round engine pauses and logs a warning.
2. **Piston** (the code runner) on the machine that hosts the API: `powershell -File infra\piston\start-piston.ps1`
   (details, capacity and troubleshooting: [`dsa-piston-hosting.md`](dsa-piston-hosting.md)). Piston has no login and is published on
   `127.0.0.1` only; never expose it.
3. **Careers site**: `pnpm --filter careers-site build` with `NEXT_PUBLIC_API_URL=/api/v1` and `API_INTERNAL_URL=<API>/api/v1`, then
   `start` (port 3300). Of the API it forwards only `/api/v1/public/*` and `/api/v1/dsa/*`. `NEXT_PUBLIC_*` and the API address are baked in at build time.
4. **Public address**: the DSA link in the email is `DSA_ASSESSMENT_URL` or `${CAREERS_SITE_URL}/dsa/{token}`. Invitations are
   emailed only when that address is public (not localhost): until then they wait in the queue and go out automatically
   afterwards. `ROUND_ALLOW_LOCAL_LINKS=on` is for local tests with Mailpit.
5. Install: `pnpm install`.

### Settings (`.env.example` has them all)
| Variable | Default | Meaning |
|---|---|---|
| `DSA_ROUNDS` | on | off = DSA rounds are run by HR (no invitation, no automatic result) |
| `CAREERS_SITE_URL` / `DSA_ASSESSMENT_URL` | localhost / empty | where the coding page lives; the emailed link |
| `PISTON_URL` | `http://127.0.0.1:2000` | the code runner (API only) |
| `DSA_PROCTOR_MAX_STRIKES` | 2 | warnings allowed before the next confirmed incident ends the test (`.env` may override; the local `.env` currently sets 3) |
| camera thresholds | 20 s / 120 s / 3 s / 3 s | face missing, looking away, more than one person, phone (`DSA_PROCTOR_*_SECONDS`, min confidence 0.5; see [`PROCTORING.md`](PROCTORING.md) §10: change the page's contracts default too, a server value above the page's turns that warning off) |
| `DSA_SHOW_SCORE` | off | on = candidates see their score on the last page |
| `DSA_ADMIN_API_KEY` | empty | reviewer routes `/dsa-admin/*` exist only with a key |
| `DSA_DEMO_MODE` | off | on = demo tokens in memory, to try the page without an HR round |
| `FEATURE_DSA` | on | off = `/dsa/*` and `/dsa-hr/*` answer 404 |
| runner limits | see hosting guide | `DSA_RUNNER_CONCURRENCY`, `DSA_RUN_*`, `DSA_JAVA_*`, ... |

The existing `AUTO_ROUND_INVITES`, `ASSESSMENT_LINK_DAYS`, `ROUND_ENGINE_PROCESSING` and `ROUND_ENGINE_POLL_MS` apply to DSA rounds too.

### Order of starting
Docker Desktop and Piston, then the API (with the settings above), the careers site, the tunnel or deployment, then check
one link before inviting students (the "remote access test" in the hosting guide).

## 7. Data kept and privacy

| What | Where | Notes |
|---|---|---|
| Invitation, token | `round_invites` | only the token's SHA-256; the token exists only in the email |
| Attempt, clock, progress, best code | `round_attempts` (`coding_state`) | deleted with the application |
| Result per problem | `round_results` (assessments) | HR only |
| Monitoring record | `dsa_proctor_sessions` | event types, times, small labels such as "Ctrl+Shift+I"; never the link token, images or typed text; deleted with the application |
| Hidden tests | API source only | never sent to a browser; the stored best code is never sent back to the candidate |

## 8. Verification (what was actually run)

Run on the development machine, 2026-11-02, against a throwaway local Postgres (all migrations applied, no schema drift):

| Check | Result |
|---|---|
| API test suite (`pnpm --filter api test` with `TEST_DATABASE_URL`, Piston running) | **654 passed, 6 skipped, 0 failed** (44 files). Skipped: the opt-in load test and 5 existing resume tests that need other services |
| New: `round-engine/dsa-round.test.ts` (engine rules, invitations, attempt lifecycle, pass / fail, time-out, recovery, races, HR view) | 26 passed |
| New: `round-engine/dsa-round.db.test.ts` (real Postgres: discovery SQL, email -> coding session -> API restart mid-test -> result -> cleared / rejection email, time-out, proctoring rows deleted with the application, token isolation, HR review own company only) | 9 passed |
| New: `dsa-bank-sync.test.ts`, contracts `dsa-bank.test.ts` | 2 and 6 passed (contracts suite 65 passed) |
| Existing round-engine tests (aptitude flow unchanged) | 30 passed |
| Live Piston suite (3 problems x Python / Java / C++) | 38 passed |
| HR dashboard tests | 75 passed |
| Type checks (api, contracts, hr-dashboard, candidate-app), API build, candidate-app production build | clean |

**Full stack in a real browser** (compiled API + production careers site + Piston + Postgres + Mailpit, the worker running by itself):
three students with a completed AI screening each received the invitation email by themselves; each opened their own
link in Chrome; A solved Easy + Medium (30 of 60), B solved Easy (10 of 60), C solved Easy in a 1-minute round and let
the time run out. Result: A got "Congratulations… the next stage is the Personal Interview", B and C got the rejection
email, nobody got a duplicate; the database shows 30 / 10 / 10 of 60 with pass mark 25 and the right outcomes; no score was
shown to any student; 16 captured API responses held no hidden test data and no stored code; the DSA link does not open the
multiple-choice API (409), a made-up token is refused (404), a write without the CSRF header is refused (403). 23 of 25
checks of that script passed at first; the 2 failures were wrong expectations in the script (the start screen lists
problem titles by design), re-checked with a fresh student: 5 of 5 passed (no statements before the start, HR's 45-minute
limit, tabs "1 Easy 10 / 2 Medium 20 / 3 Hard 30").

Not verified: the HR dashboard pages in a browser (type-checked and unit-tested only), a deployment with a public URL
(tested with local links via `ROUND_ALLOW_LOCAL_LINKS=on`), more than one API instance.

## 9. Known limits and follow-ups

- **Three problems in the bank.** Adding one means: its full data and hidden tests in `questions/mock-questions.data.ts`, an entry
  in `DSA_BANK` (contracts), and, for a function shape that does not exist yet, a harness in `evaluation/harness.ts`
  (`tests/dsa-bank-sync.test.ts` fails until both lists agree). HR can instead write their own problem in the rounds
  editor (section 2), judged as a stdin / stdout program; a reusable bank of HR's own problems across jobs is future work.
- **The live Piston tests are timing-sensitive.** Run alone (`vitest run tests/dsa-piston.integration.test.ts`) they
  pass; during a full parallel `pnpm test` the local-compiler suite can load the CPU enough that Java on Piston hits its
  time limit. `vitest run --no-file-parallelism` runs everything in sequence.
- **C++ and Java are slow** (a compile per test case; about 9 to 12 s for a full C++ Submit) and 20 simultaneous C++
  submissions queue for up to about two minutes: stagger invitations for large batches. See the hosting guide.
- **One API instance**: the "one Run at a time per candidate" guard and the per-process runner queue live in memory. Several API
  instances would need a shared lock and a shared queue. (The one-Submit-at-a-time rule is already in the database: section 3.)
- **Monitoring records are written read-modify-write**: two event batches of one candidate arriving at the very same moment could
  lose the smaller one. The browser sends batches one after another, so this has not been seen.
- **The mock data repository's name remains** (`MockQuestionRepository` is the demo path; `BankQuestionRepository` serves HR rounds).
- **Not done**: a SQL round on the same mechanism (Piston can run `sqlite3`); HR-uploaded problems; resuming a withdrawn link
  with a new one; showing the monitoring summary on the Assessments table.
- The teammate-owned modules touched by this wiring are listed in section 10.

## 10. Changes outside the dsa folder (for the owners to review)

| File | Change |
|---|---|
| `packages/contracts`: `schemas/dsa-bank.ts` (new), `schemas/rounds.ts`, `schemas/round-engine.ts`, `index.ts` | bank list and marker rules, `kind` on the HR engine view |
| `apps/api/prisma/schema/round_engine.prisma`, `applications.prisma`, migration `20261102120000_dsa_round` | `coding_state` column, `dsa_proctor_sessions` table (+ one relation line) |
| `apps/api/src/modules/round-engine/*` | DSA round kind, coding attempt methods, invitation wording and link, discovery SQL, module `exports` |
| `apps/api/src/app.module.ts` | registers `DsaModule` |
| `apps/hr-dashboard`: `question-editor.tsx`, `online-test-panel.tsx`, `round-engine-api.ts` | problem picker, DSA panel and monitoring record |
| `.env.example`, `pnpm-lock.yaml` | settings; the candidate app's entry in the lockfile (additive) |
