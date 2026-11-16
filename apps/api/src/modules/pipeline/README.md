# pipeline

| | |
|---|---|
| **Routes** | `/api/v1/pipeline/jobs/:jobId/*` (HR, `jobs.read` / `jobs.write`), behind `FEATURE_ROUNDS` |
| **Tables** | `job_pipeline_settings`, `round_rubrics`, `pi_calls` (pipeline.prisma); `gd_evaluations.rubric_*` |
| **Guide** | [docs/HIRING_PIPELINE.md](../../../../../docs/HIRING_PIPELINE.md) |

The rules between the rounds. The pure rules (stages, Stage 2 verdict, status, gate, rubric checks) live in
`packages/contracts/src/schemas/pipeline.ts`, so the API and the dashboard compute the same thing.

| Used by | Through |
|---|---|
| round engine | `failsStage2Overall()` after the last technical round, `gateAllows()` before handing a student to a module, `rejectionEmailsOn()` before a rejection email |
| group-discussion | `rubricOf()`, `checkRubricScores()`, `rejectionEmailsOn()` |

Statuses are computed from round results + settings, never stored. Settings and rubrics freeze with the rounds.
Tests: `packages/contracts/tests/pipeline.test.ts`, `apps/api/tests/pipeline/pipeline-flow.test.ts`.

## Stage 2 rule AVERAGE_OF_ROUNDS (default)

The technical rounds (DSA, SQL, GD - whichever the job has, in HR's order) are judged together:

- Each student gets only the first round's link; the next round's link once they finish it (pass **or** fail).
- A failed technical round does not reject on its own (`pipelineStatusOf`, `RoundEngineService.nextFor`, the module /
  GD pool queries via `averagesTechnicalRoundsSql`, and GD confirmation all honour it).
- After the last technical round: average of the student's percentages (score / max per round) >= average of those
  rounds' pass marks (pass mark / max). 3 rounds = average of 3, 2 = average of 2. Passed -> the technical interview
  link (gate `stage2GateAllows`); failed -> one rejection email (`REJECTED_MODULE2_OVERALL`).
- A job without a settings row uses it; migrations `20261116120000_stage2_average_of_rounds` (+ `..._default`).
  The other rules (ALL_ROUNDS_PASSED, TOTAL_PERCENT, BOTH) stay selectable in the job's Pipeline rules.
