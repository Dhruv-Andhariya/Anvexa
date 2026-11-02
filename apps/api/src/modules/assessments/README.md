# assessments

| | |
|---|---|
| **Doc modules** | M05 / M22 (results side) |
| **Release** | v0.3 |

Results of the assessment rounds. The round engine (teammate) records one result per student per round; HR sees them
on the **Assessments** page of the HR dashboard and can override pass / fail with a reason. Rounds and their pass
rules come from the `rounds-config` module.

## Built so far
| File | What it does |
|---|---|
| `assessments.service.ts` | `record()` for the round engine; HR job view, student review, override |
| `grading.ts` | The ONE place pass / fail is decided (`gradeResult`), outcome (override wins), overall stage |
| `assessments.store.ts` | All database access (Prisma) behind an abstract class. Every query filters by `tenant_id` |
| `assessments.controller.ts` | HR routes (below), behind `FEATURE_ROUNDS` |

Table: `round_results` in `prisma/schema/rounds.prisma` — one row per application per round, deleted with the
application (DPDP erase) or the job.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/assessments/jobs` | HR (`jobs.read`) | approved jobs with rounds status, students, results received |
| GET | `/api/v1/assessments/jobs/:jobId` | HR (`jobs.read`) | every student who reached the rounds × every round: outcome, score; pass / fail counts per round |
| GET | `/api/v1/assessments/applications/:applicationId` | HR (`jobs.read`) | full review: ATS score, voice screening flag, every round with pass mark, result and answers |
| PUT | `/api/v1/assessments/applications/:applicationId/rounds/:roundId/override` | HR (`jobs.write`) | body `{ passed, reason }` (`passed: null` = back to the system result) |

"Students who reached the rounds" = shortlisted after resume screening (HR's decision, else the ATS suggestion), or
anyone with a round result. The AI voice screening notes on the review page come from the existing
`GET /api/v1/screening/applications/:id`.

## For the round engine (teammate)

Import **only** from `../assessments` (index.ts). In-process, no HTTP:

```ts
import { AssessmentsService } from '../assessments';

const res = await assessments.record(tenantId, {
  applicationId,           // the student's application
  roundId,                 // from RoundsConfigService.forRoundEngine()
  // send what the round's pass rule needs:
  correctCount: 9,         // CORRECT_COUNT
  marks: 34,               // MARKS / PERCENTAGE (or marksAwarded per answer)
  interviewerScore: 7,     // INTERVIEWER_SCORE
  answers: [{ questionId, selected: [1] }, { questionId, answer: 'SELECT …', marksAwarded: 8, feedback: '…' }],
  notes: 'Interviewer notes for HR',
  startedAt, submittedAt,  // ISO strings
});
// res = { resultId, outcome: 'PASSED' | 'FAILED', systemPassed, score, maxScore, passMark }
```

- Shape: `roundResultInputSchema` in `packages/contracts/src/schemas/assessments.ts`.
- Choice answers (MCQ / true-false) without `isCorrect` are graded here against the saved correct options.
- The round must belong to the student's job, same company, and the rounds must be `COMPLETE`
  (`ROUND_NOT_FOUND` / `ROUNDS_NOT_COMPLETE`). Impossible numbers (more correct answers than questions, marks above a
  question's worth, unknown question ids) are `422 INVALID_ROUND_RESULT` and nothing is saved.
- The first result locks the job's rounds. Sending the same result again replaces it; an HR override stays.
- **Audit:** `assessment.result_recorded`, `assessment.result_overridden`, `assessment.override_removed`.
