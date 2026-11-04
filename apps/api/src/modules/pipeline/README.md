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
