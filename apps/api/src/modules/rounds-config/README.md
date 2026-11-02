# rounds-config

| | |
|---|---|
| **Owner** | Intern 1 (Core & HR) |
| **Doc modules** | M05 |
| **Release** | v0.3 (HR picks rounds, questions and pass marks; AI suggests questions) |

Round configurator: which assessment rounds a job has, in which order, their questions and passing criteria. HR sets
them up in the **Publish** dialog of the HR dashboard. Every job (and so every company) has its own rounds.

```
Resume screening ─► AI voice screening ─► [ the job's own rounds, in order ] ─► offer
   (fixed)               (fixed)            Aptitude · SQL · GD · HR Interview · custom…
```

## Privacy rule

Only the round **names** ever leave the company: when HR publishes, the publisher copies them (in order) into
`publisher_job_listings.selection_process`, which the careers page and the LinkedIn post show as the
"Selection process" — exactly like before. Questions, answers, pass marks and time limits are never part of a post,
the careers page or any public API. No route of this module is `@Public()`.

## Built so far
| File | What it does |
|---|---|
| `rounds-config.service.ts` | Save rounds (draft / complete), lock, AI suggestions (nothing saved), public steps for the publisher, round engine read API |
| `rounds-config.store.ts` | All database access (Prisma) behind an abstract class. Every query filters by `tenant_id` |
| `question-generator.client.ts` | AI worker client: `POST /v1/rounds/questions` (prompt `prompts/round_questions.v1.yaml`) |
| `rounds-config.controller.ts` | HR routes (below), behind `FEATURE_ROUNDS` |

Tables: `prisma/schema/rounds.prisma` (`job_round_configs`, `job_rounds`, `round_questions`). Migration
`20261030100000_assessment_rounds` (additive only).

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/rounds/jobs/:jobId` | HR (`jobs.read`) | rounds, questions, pass rules, `problems` still missing |
| PUT | `/api/v1/rounds/jobs/:jobId` | HR (`jobs.write`) | body `{ rounds, complete }` — replaces every round of the job |
| POST | `/api/v1/rounds/jobs/:jobId/generate` | HR (`jobs.write`) | AI suggestions for one round (1–20, difficulty, topics). Saves nothing |

## Rules
- **Draft vs complete.** A draft can miss anything. `complete: true` needs ≥ 1 round, a passing criterion on every
  round, and questions on every round that is not scored by an interviewer. The checks are the shared contract
  (`packages/contracts/src/schemas/rounds.ts`), used by the API **and** the dashboard editor.
- **Pass mark limits (always, even in a draft).** Correct answers ≤ number of questions; marks ≤ total marks;
  percentage ≤ 100; interviewer score ≤ its maximum. The database CHECKs keep every row sane on its own.
- **Publishing.** The publisher refuses to publish until the rounds are `COMPLETE` (`ROUNDS_INCOMPLETE` in the preview
  errors). Without the migration (or with `FEATURE_ROUNDS=off`) publishing works exactly as before (typed steps).
- **Lock.** Once students start (`lockForAttempts`, or the first result recorded by the assessments module) the rounds,
  questions and criteria can no longer change: `409 ROUNDS_LOCKED`.
- **Company isolation.** The company is always the session's (`TenantContext`); another company's job is a 404.
  Ids sent by the browser are kept only when they already belong to this job.
- **Audit.** `rounds.draft_saved`, `rounds.completed`, `rounds.questions_generated`, `rounds.locked` (names and counts
  only — never questions or pass marks).

## For the round engine (teammate)

Import **only** from `../rounds-config` (index.ts). In-process, no HTTP:

```ts
import { RoundsConfigService } from '../rounds-config';

// Every round of the job, in order, with questions, correct options, model answers and pass rules.
const config = await rounds.forRoundEngine(tenantId, jobId); // null = job has no rounds
// config.status === 'COMPLETE' before running; config.rounds[i].questions[j].id is what answers refer to.

// The first student starts -> freeze the rounds (safe to call many times).
await rounds.lockForAttempts(tenantId, jobId);
```

Results go to the **assessments** module: `AssessmentsService.record(tenantId, result)` (see its README).
