# Hiring pipeline: the rules between the rounds

How a student moves through a job's rounds, and what HR controls on top of each round's own pass rule.
Code: `apps/api/src/modules/pipeline` (rules, settings, HR views), pure rules in `packages/contracts/src/schemas/pipeline.ts`,
hooks in `round-engine` (next step) and `group-discussion` (rubric, confirm). Tables: `apps/api/prisma/schema/pipeline.prisma`.

## 1. The stages

Every round type belongs to a stage. HR's round order (`position`) is always read from the job's rounds and never
hard-coded. A student moves on only after passing.

| Stage | Round types | Who scores |
|---|---|---|
| 1 Aptitude | `APTITUDE`, `TECHNICAL_MCQ`, `COMMUNICATION` | online test (automatic) |
| 2 Technical rounds | `CODING` (DSA), `SQL`, `GROUP_DISCUSSION`, in the order HR chose | DSA / SQL automatic; GD by HR's rubric (or the AI) |
| 3 Technical interview | `AI_INTERVIEW`, `TECHNICAL_INTERVIEW` | HR's decision after the AI report |
| 4 Personal interview | `HR_INTERVIEW` | HR call, status on the Personal interview page |

`CUSTOM` rounds are "other": they run as before and reject as `REJECTED_OTHER`.

## 2. Stage 2 overall criterion (per job)

Set in the rounds editor ("Pipeline rules"). Checked once, when the student finishes the **last** technical round:

| Rule | Passes when |
|---|---|
| `ALL_ROUNDS_PASSED` (default, the behaviour before) | every technical round passed its own rule |
| `TOTAL_PERCENT` | marks scored / total marks across the technical rounds x 100 >= the minimum |
| `BOTH` | both (AND) |

Each round counts in its own pass rule's unit, so a `MARKS` round adds its marks and an interviewer-score round adds its
score out of its maximum. The percentage is rounded down to 2 decimals.

A failed criterion rejects the student (`REJECTED_MODULE2_OVERALL`) with the normal rejection email on that round, and
the technical interview module never receives them: `RoundEngineService.waitingForModule()` filters with
`PipelineService.gateAllows()`. The same gate applies to any round placed after the technical rounds.

## 3. Rejection reasons (status)

The status is **computed** from the round results (HR overrides included) and the settings. Nothing extra is stored, so
the dashboard and the next-step logic can never disagree (`pipelineStatusOf()`):

`NOT_STARTED`, `IN_APTITUDE`, `IN_TECHNICAL_ROUNDS`, `IN_TECH_INTERVIEW`, `IN_PERSONAL_INTERVIEW`, `CLEARED`, `SELECTED`,
`REJECTED_APTITUDE`, `REJECTED_MODULE2_ROUND`, `REJECTED_MODULE2_OVERALL`, `REJECTED_TECH_INTERVIEW`,
`REJECTED_PERSONAL_INTERVIEW`, `REJECTED_OTHER`.

Shown on the Assessments page (Status column, CSV export) and returned by `GET /pipeline/jobs/:jobId/statuses`.

## 4. Rejection emails on / off (per job)

"Email students who are not selected" in Pipeline rules (default **on**, as before). Off = no round rejection email
(`round_outcome_emails` row not created) and no GD "not selected" email; HR still sees the reason. Invitations and
"cleared" emails are unaffected. Emails are only ever queued by pipeline transitions, never by hand.

## 5. GD rubric

On a group discussion round card: parameters with marks (e.g. Communication 10, Content 10, Leadership 5,
Listening 5). With a rubric:

- On the GD results page HR scores every attended student ("Score"). Every parameter exactly once, `0..maxMarks`. Out of
  range is refused with `400 RUBRIC_SCORES_INVALID` (never clamped).
- The rubric total decides the student (scaled to the round's interviewer score when the pass rule is
  `INTERVIEWER_SCORE`), unless HR overrides the decision. The AI's scores stay visible as a guide.
- "Confirm selection" is refused (`409 GD_RUBRIC_INCOMPLETE`) until everyone who took part is scored.

Without a rubric the AI's overall score decides, as before. The rubric is stored without a foreign key to `job_rounds`,
because the rounds editor re-creates those rows on every save.

**Fixed with this change:** after "Confirm selection" a selected student now moves on
(`RoundEngineService.continueAfterExternalRound()`): an online round after the GD (for example SQL or DSA) gets its
invitation, and the Stage 2 criterion is checked when the GD is the last technical round. Before, a GD followed by an
online round left the student waiting.

## 6. Personal interview section

`/personal-interview` in the HR dashboard: per job, only the students who cleared every round before the HR interview
(or every round, when the job has no HR interview round), best overall percentage first. Each card shows the name, a
`tel:` phone link, the email and college, the aptitude %, the score of each DSA / SQL / GD round, the Stage 2 overall %,
the technical interview score and remarks, and the overall %. HR records the call status (Not called / Called /
Scheduled / Selected / Rejected) with notes (`pi_calls`, deleted with the application). Selected or Rejected sets the
pipeline status. Export CSV.

## 7. Freezing

Pipeline rules and rubrics can be changed until the first student starts the job's rounds (`job_round_configs.locked_at`).
After that `409 PIPELINE_LOCKED`, exactly like the rounds themselves.

## 8. API (HR session, `jobs.read` / `jobs.write`, behind `FEATURE_ROUNDS`)

| Method | Path |
|---|---|
| GET / PUT | `/api/v1/pipeline/jobs/:jobId/settings` - `{ stage2Rule, stage2MinPercent, rejectionEmails }` |
| GET / PUT | `/api/v1/pipeline/jobs/:jobId/rounds/:roundId/rubric` - `{ parameters: [{ name, maxMarks }] }` (empty = none) |
| GET | `/api/v1/pipeline/jobs/:jobId/statuses` |
| GET | `/api/v1/pipeline/jobs/:jobId/personal-interview` |
| PUT | `/api/v1/pipeline/jobs/:jobId/personal-interview/:applicationId` - `{ status, notes }` |
| PUT | `/api/v1/group-discussion/batches/:batchId/students/:participantId/rubric` - `{ scores: [{ parameter, marks }], remarks }` |

Migration `20261104160000_pipeline_rules` adds only new tables, enums and columns.

## 9. Tests

- `packages/contracts/tests/pipeline.test.ts`: the Stage 2 percentage (rounding, marks vs percent, AND logic), every
  status, the gate, settings and rubric validation (over-max, unknown, missing, duplicate parameters).
- `apps/api/tests/pipeline/pipeline-flow.test.ts`: candidates through the real round engine, assessments and pipeline
  services (in memory), with Stage 2 order GD -> SQL -> SQL 2. A passes everything and lands in the personal interview
  section. B fails aptitude (one rejection). C passes every Stage 2 round but fails the overall percentage (never handed
  to the technical interview). D fails the technical interview. Also covered: a duplicate result changes nothing, marks
  above a question's marks are refused, rejection emails off, freezing, and no settings = the old behaviour.

## 10. Known limits

- An HR override on the Assessments page does not re-run the next step (as before this change).
- The technical interview has no HR-defined rubric: its result is HR's ADVANCE / REJECT after the AI report.
- The GD worker's AI still scores its own fixed criteria; HR's rubric is HR's evaluator form, not an AI prompt.
