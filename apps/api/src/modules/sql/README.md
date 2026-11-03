# sql module — SQL question bank and SQL sandbox

| | |
|---|---|
| **Owner** | SQL rounds |
| **Routes** | `/api/v1/sql-hr/questions*` (HR, `jobs.read` / `jobs.write`), behind `FEATURE_SQL` |
| **Tables** | `sql_questions` (sql_bank.prisma), `round_questions.sql_spec` (rounds.prisma) |
| **Guide** | [docs/SQL_ASSESSMENT_ROUND.md](../../../../../docs/SQL_ASSESSMENT_ROUND.md) |

A SQL round is **not** a separate page or pipeline. A round question holding a SQL problem counts as an online coding
problem (`isDsaQuestion` in contracts), so the round engine runs a SQL round exactly like a DSA round: invitation email,
personal link to the candidate app's coding page (`/dsa/[token]`), timer, proctoring (two warnings, the third
violation ends the attempt), scoring, result in the assessments module, next-round / outcome email. This module adds
what is SQL-specific:

| File | What |
|---|---|
| `engine/sql-sandbox.ts` | Runs SQL: one Node process per run (`node -e`, no environment, killed at the time limit), concurrency limit shared with nothing else |
| `engine/worker-source.ts` | The program in that process: a fresh in-memory SQLite database per dataset; HR's schema and data load, then the database is locked read-only (`query_only` + an authorizer allowing only SELECT / read / functions / recursive CTEs); rows stop at 1000; SQLite memory capped |
| `engine/statements.ts` | Exactly one statement per query (SQLite's prepare would silently ignore a second one) |
| `engine/compare.ts` | Result vs expected **as tables**: column count and names (case-insensitive), values (numbers within 1e-6, NULL only = NULL, a number never = text), duplicates; row order only when the question says so |
| `bank/build-problem.ts` | Runs HR's question (schema, every dataset, reference query) and builds the problem: tables, sample rows, expected results. A question that does not run is never stored |
| `bank/sql-bank.service.ts`, `bank/sql-bank.store.ts` | CRUD, activate / deactivate, starter import, audit (`sql.question_*`) |
| `bank/starter-questions.ts` | The 15 starter questions (input only; expected results are computed) |
| `sql-hr.controller.ts` | HR routes (below) |

The coding page side lives in the dsa module: `questions/sql-problem.ts` (round copy → problem the page runs),
`evaluation/sql-evaluator.ts` (judging), `questions/question.types.ts` (`languages`, `sql` view: tables + SAMPLE
datasets only; never the reference query, hidden datasets or their results).

## HR routes

| Method | Path | |
|---|---|---|
| GET | `/sql-hr/questions` | the bank (no datasets) |
| GET | `/sql-hr/questions/:id` | one question with datasets, expected results and reference query |
| POST | `/sql-hr/questions/check` | runs a question without saving: problems, or tables + expected results |
| POST | `/sql-hr/questions` | create (422 `SQL_QUESTION_NOT_RUNNABLE` with `issues` when it does not run) |
| PUT | `/sql-hr/questions/:id` | replace (rounds keep their copy) |
| PATCH | `/sql-hr/questions/:id/active` | `{ active }` - inactive questions cannot be picked for new rounds |
| DELETE | `/sql-hr/questions/:id` | rounds keep their copy |
| POST | `/sql-hr/questions/starter` | adds the starter questions the company does not have (`{ added, skipped }`) |

CLI: `COMPANY_SLUG=<slug|all> pnpm --filter api sql:seed` adds the starter questions from the command line.

Env: `FEATURE_SQL`, `SQL_RUNNER_CONCURRENCY` (4), `SQL_RUNNER_HEAP_MB` (64), `SQL_RUNNER_MAX_QUEUE`,
`SQL_RUNNER_QUEUE_TIMEOUT_MS`, `SQL_RUNNER_STARTUP_MS`.

Tests: `tests/sql/*` (sandbox security and limits, comparison, starter questions incl. typical wrong answers, bank
service, the whole round through the round engine and the coding page service, HTTP routes and app wiring).
