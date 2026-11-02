# M05 Assessment Rounds (HR side)

HR chooses the assessment rounds of a job, its questions and passing criteria **on the Publish job page**. Everything
is saved straight into the database **for that one job** (and that company). The same rows feed the HR
**Assessments** page and the round engine that conducts the rounds. Nothing is copied.

Module code: [`apps/api/src/modules/rounds-config`](../apps/api/src/modules/rounds-config/README.md) (rounds and
questions) and [`apps/api/src/modules/assessments`](../apps/api/src/modules/assessments/README.md) (results).

## 1. The flow

```
HR: Publish page ─► "Publish" on a job ─► dialog step 1 "Assessment rounds"
      fixed: 1. Resume screening  2. AI voice screening
      HR adds rounds 3, 4, 5…  (type, name, description, time limit, passing criterion, questions — own or AI)
      "Save draft"     ─► PUT /api/v1/rounds/jobs/:jobId  { complete: false }  ─► DB (status DRAFT)
      "Preview posts"  ─► PUT /api/v1/rounds/jobs/:jobId  { complete: true }   ─► DB (status COMPLETE) ─► preview
      "Confirm & publish" ─► publisher copies ONLY the round names, in order, into the public "Selection process"

DB  job_round_configs ─┬─ job_rounds ── round_questions          (one set per job, tenant_id on every row)
                       │
                       ├─► HR "Assessments" page ─► tab "Assessment Rounds"   (reads the same rows, at once)
                       │
                       └─► round engine (teammate) ─► forRoundEngine(tenantId, jobId)
                                 runs the rounds for students ─► AssessmentsService.record(...)
                                                                   ─► round_results
                                                                   ─► HR "Assessments" ─► tab "Students"
```

As soon as HR clicks **Save draft** or **Preview posts**, the rounds and questions are in the database. Opening
**Assessments → (pick the job) → Assessment Rounds** shows them. There is no extra "sync" step, because both pages
read the same tables.

## 2. The HR page (Publish job dialog)

Where: HR dashboard → **Publish** → **Publish** on an approved job → first step of the dialog.

What HR can do:

| Action | How |
|---|---|
| Add a round | pick a type (Aptitude, Technical MCQ, Coding, SQL, Communication, Group Discussion, Technical Interview, HR Interview, Custom), then **+ Add round** |
| Order / rename / remove | ↑ ↓ buttons, the name field, **Remove** (asks first if the round has questions) |
| Description, time limit | per round, both optional and private |
| Passing criterion | number of correct answers · percentage of marks · marks · interviewer score out of N |
| Add own questions | MCQ, True / false, Short answer, Descriptive, Coding, Interview; edit, delete, reorder (↑ ↓) |
| AI questions | **✨ Generate with AI**: count (1–20), difficulty, topics, question types → review → tick → **Add selected** |
| Save | **Save draft** at any time; **Preview posts** saves as complete first (blocked until nothing is missing) |

Editor rules (the same shared schema runs in the browser and the API, so the messages match):
- The pass mark can never be more than the total: correct answers ≤ number of questions, marks ≤ total marks,
  percentage ≤ 100, interviewer score ≤ its maximum. This applies to drafts too.
- **Complete** needs ≥ 1 round, a passing criterion on every round, and questions on every round that is not
  interviewer-scored.
- Two rounds cannot have the same name. A job has at most 10 rounds and a round at most 100 questions.
- Jobs published before this feature: their typed selection process becomes a first draft of rounds
  ("Online Apptitude Exam" → Aptitude, "SQL Round" → SQL, "Personal Interview" → HR Interview…).
- Once students start (locked), the editor is read-only and the API answers `409 ROUNDS_LOCKED`.
- Without the migration or with `FEATURE_ROUNDS=off`, the dialog shows the old textarea and publishing works as before.

### Frontend files

| File | What it is |
|---|---|
| `apps/hr-dashboard/src/components/publish/publish-dialog.tsx` | The Publish dialog; step 1 now hosts the rounds editor, Save draft, Preview |
| `apps/hr-dashboard/src/components/rounds/rounds-editor.tsx` | Fixed steps + list of rounds + "Add round" |
| `apps/hr-dashboard/src/components/rounds/round-card.tsx` | One round: name, type, description, time limit, passing criterion, its questions |
| `apps/hr-dashboard/src/components/rounds/question-editor.tsx` | One question (options / correct answer, expected answer, marks, difficulty) |
| `apps/hr-dashboard/src/components/rounds/ai-generate-panel.tsx` | "Generate with AI": ask, review, keep the picked ones |
| `apps/hr-dashboard/src/lib/rounds.ts` | Editor state ↔ API request, validation with the shared schema, helpers (no UI) |
| `apps/hr-dashboard/src/lib/rounds-api.ts` | API calls (rounds + assessments) |
| `apps/hr-dashboard/src/app/assessments/…` | Assessments page (job picker, Students / Assessment Rounds tabs) and the student review page |

## 3. What is saved in the database

Schema: `apps/api/prisma/schema/rounds.prisma`. Migration: `20261030100000_assessment_rounds` (additive only).
Every table has `tenant_id`. Rounds are linked to `(job_id, tenant_id)`, so a job's rounds can only belong to
that job's company. Deleting the job deletes its rounds, and erasing an application deletes its results.

| Table | One row per | Main columns |
|---|---|---|
| `job_round_configs` | job | `status` DRAFT / COMPLETE, `locked_at`, `updated_by_id` |
| `job_rounds` | round of a job | `position` (1 = first round after voice screening), `type`, `name` (public), `description`, `time_limit_minutes`, `pass_mode`, `pass_value`, `pass_max_score` |
| `round_questions` | question of a round | `position`, `kind`, `text`, `options[]`, `correct[]` (option indexes), `model_answer`, `language`, `marks`, `difficulty`, `topics[]`, `source` HR / AI |
| `round_results` | student × round | score, max score, pass mark, `system_passed`, `answers` (JSON), notes, override (passed, reason, by, at) |

How a save works: `PUT /rounds/jobs/:jobId` sends **all** rounds of the job. The API replaces them in one
transaction and keeps the ids of rounds and questions that already belonged to this job. The ids therefore stay
stable between saves, and the round engine's answers can refer to them.

## 4. Private vs public

| Shown to students (careers page, LinkedIn, public API) | Never leaves the HR team |
|---|---|
| Round **names**, in order, as "Selection process", e.g. `Online Apptitude Exam → SQL Round → Group Discussion → Personal Interview` | questions, options, correct answers, model answers, marks, pass marks, time limits, descriptions, results |

The publisher builds the selection process from the saved rounds on the server. Text sent by the browser is
ignored. No route of `rounds-config` or `assessments` is public. Tests check that the public job page response has
no round details.

## 5. API routes (HR, company from the session)

| Method | Path | Permission |
|---|---|---|
| GET / PUT | `/api/v1/rounds/jobs/:jobId` | `jobs.read` / `jobs.write` |
| POST | `/api/v1/rounds/jobs/:jobId/generate` (saves nothing) | `jobs.write` |
| GET | `/api/v1/assessments/jobs` · `/api/v1/assessments/jobs/:jobId` | `jobs.read` |
| GET | `/api/v1/assessments/applications/:applicationId` | `jobs.read` |
| PUT | `/api/v1/assessments/applications/:applicationId/rounds/:roundId/override` | `jobs.write` |

Another company's job, round or student is always a **404**. Request and response shapes:
`packages/contracts/src/schemas/rounds.ts` and `assessments.ts`.

AI questions: API → AI worker `POST /v1/rounds/questions`, prompt `prompts/round_questions.v1.yaml`. The API checks
every suggestion again with the shared schema and drops broken or repeated ones.

## 6. Wiring for the round engine (teammate)

The round engine lives in the same API. It imports the two modules **only through their `index.ts`**, with no HTTP
and no second copy of the data:

```ts
import { RoundsConfigService } from '../rounds-config';
import { AssessmentsService } from '../assessments';

// 1. What HR saved for this job (same rows HR sees in the Assessment Rounds tab)
const config = await rounds.forRoundEngine(tenantId, jobId);
//    null = no rounds; run only when config.status === 'COMPLETE'
//    config.rounds[i] = { id, position, type, name, timeLimitMinutes, passRule, questions: [{ id, kind, text, options, correct, modelAnswer, marks, … }] }

// 2. First student starts -> freeze questions and criteria (safe to call again)
await rounds.lockForAttempts(tenantId, jobId);

// 3. After each finished round of each student -> result appears on the HR Assessments page
await assessments.record(tenantId, {
  applicationId, roundId,
  correctCount,        // CORRECT_COUNT rounds
  marks,               // MARKS / PERCENTAGE rounds (or marksAwarded per answer)
  interviewerScore,    // INTERVIEWER_SCORE rounds
  answers: [{ questionId, selected: [1] }, { questionId, answer: '…', marksAwarded: 4 }],
  notes, startedAt, submittedAt,
});
// -> { outcome: 'PASSED' | 'FAILED', score, maxScore, passMark }
```

- Pass / fail is decided **only** in `assessments/grading.ts`. Send the numbers and let the module decide.
- MCQ and true / false answers without `isCorrect` are graded against the saved correct options.
- The first result also locks the rounds. Sending the same result again replaces it, but an HR override stays.
- Which students: the Assessments page lists students **shortlisted after resume screening** (HR's decision, else
  the ATS suggestion), plus anyone who already has a round result.
- **Round engine (built, M13):** online test rounds (MCQ / true-false only) are run by
  `apps/api/src/modules/round-engine`: invitation after the AI voice screening, the student test page
  (`/assessment/[token]`), proctoring events, and the order / gating between rounds (stops at the first failed
  round, like `stageOf()`). See [APTITUDE_ASSESSMENT_ROUND.md](APTITUDE_ASSESSMENT_ROUND.md). Coding, descriptive
  and interview rounds are still run by HR.

## 7. Run, test, turn off

- Migration: `cd apps/api; npx prisma migrate deploy` (already applied on the team Neon DB, 30 Oct 2026).
- Env (all optional, defaults in `.env.example`): `FEATURE_ROUNDS=on`, `ROUND_QUESTIONS_WORKER_TIMEOUT_MS=90000`
  (API), `ROUND_QUESTIONS_BUDGET_SECONDS=75` (AI worker).
- Tests:
  - `packages/contracts/tests/rounds.test.ts`
  - `apps/api/tests/rounds/*` (save, draft vs complete, lock, AI suggestions, company isolation, grading, override)
  - `apps/api/tests/publisher/publisher.service.test.ts` (selection process = round names, publish blocked until complete)
  - `apps/hr-dashboard/tests/rounds.test.ts`
  - `workers/ai-worker/tests/test_round_questions.py`

## 8. Known gaps / next steps

- The **Assessment Rounds** tab shows each round's criterion, number of questions, marks, time limit and results,
  but not the question texts. Questions are edited on the Publish page; a read-only question list could be added
  to the tab later.
- "Pass mark ≤ questions / marks" is checked by the API inside the save. It is not a database CHECK, because it
  needs the questions table. Simple limits (percentage ≤ 100, interviewer score ≤ max, score ≤ max score) are
  database CHECKs.
- No HR edit of results other than the pass / fail override (with reason, audited).
