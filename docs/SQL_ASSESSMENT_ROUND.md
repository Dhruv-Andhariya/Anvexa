# SQL assessment round

Students answer SQL problems on the same proctored coding page as the DSA round. HR manages the questions in a
database-backed SQL question bank and picks them for a job's SQL round. Code: `apps/api/src/modules/sql` (bank,
sandbox; [README](../apps/api/src/modules/sql/README.md)), the dsa module (coding page API), the round engine (invites,
grading, emails), `apps/candidate-app/src/app/dsa/[token]` (page), `apps/hr-dashboard/src/app/sql-questions` (bank).

## 1. How it fits in

A SQL round is not a separate system. A round whose questions are all coding problems, whether DSA problems or SQL
problems, is run online by the round engine. Because of that, a SQL round gets everything DSA rounds already have,
with no extra wiring:

- **Invitation:** after AI screening when it is the first round, or after the student passes the round before it.
  The invitation email speaks of SQL problems.
- **Candidate page:** the same timer, question tabs, editor, Run / Submit, results panel and finish dialog.
- **Proctoring:** full screen; tab, focus, clipboard and screenshot-shortcut events. With `DSA_PROCTOR_MAX_STRIKES=2`
  there are **two warnings, and the third violation ends the attempt** as a proctoring violation. Answers submitted
  before that still count.
- **Grading:** in the assessments module (pass rule, HR Assessments page, the submitted query kept per question), then
  the next round's invitation, or the cleared / rejection email.

## 2. HR: questions

**SQL questions** (HR dashboard navigation):
- **Add the 15 starter questions:** 5 easy, 5 medium, 5 hard. Safe to press twice. From the command line:
  `COMPANY_SLUG=<slug|all> pnpm --filter api sql:seed`.
- **New question / Edit:** fill in the following.
  - Title, description (shown to candidates; say which columns and whether order matters), difficulty, marks,
    topics, time limit per query.
  - **Schema:** the `CREATE TABLE` statements (SQLite).
  - **Reference query:** the correct answer, never shown to candidates. Its result on each dataset **is** the
    expected output, so expected outputs are never typed by hand.
  - **Starter query:** empty means `SELECT * FROM <first table>;`.
  - **Datasets:** `INSERT` statements, each loaded into a fresh copy of the schema. *Sample* datasets are shown to
    candidates (rows and expected output) and used by Run. *Hidden* datasets only grade Submit; use them for NULLs,
    ties and empty tables.
  - **Row order matters:** tick only when the question asks for an ORDER BY.
- **Check question:** runs everything on the server and shows each dataset's expected output, or exactly what fails.
  Save also runs it, and a question that does not run is not saved.
- **Activate / Deactivate:** inactive questions stay in the bank but cannot be picked for new rounds.
- **Delete:** removes the question from the bank.

**Rounds editor (job publish page):** add a round of type **SQL** and add **Coding** questions. In the problem dropdown,
choose a question from the **SQL question bank** group. The round keeps a **copy**: editing or deleting the bank
question later never changes a round students may already be taking. To use a newer version, pick the question again
before the round starts. DSA problems and SQL problems can be mixed in one round.

## 3. Candidates

The page title is **SQL Assessment** when every question is SQL, and the intro explains queries and datasets. For each
question the candidate sees:
- **Database schema:** tables, columns and types.
- **Sample data:** the rows of each table for every sample dataset, with the **expected output** table.
- **Editor:** SQL highlighting, line numbers, Tab indent and auto-indent. Buttons: **Reset query**, **Run query**
  (sample datasets) and **Submit answer** (all datasets, scored).
- **Results:** your result table next to the expected table, with what differs, for example
  `Column 2 should be named "average_salary" (got "avg")`. Hidden datasets show pass / fail only.

Marks per question = marks × datasets passed / datasets. The best submission counts.

## 4. Execution and security

- Queries **never** touch the application database. Each run is a separate Node process (no environment variables, so
  no secrets), with a **fresh in-memory SQLite database per dataset**.
- Read-only: HR's schema and data load first. The database is then locked (`PRAGMA query_only` plus an authorizer that
  allows only SELECT / reading / functions / recursive CTEs). INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, ATTACH,
  PRAGMA and transactions fail with a readable message.
- Exactly **one** statement: `SELECT 1; DROP TABLE t` is refused before anything runs.
- Limits:
  - **Time:** the per-question limit (default 2 s). The process is killed, so an endless query never blocks the API.
  - **Rows:** 1000 rows maximum.
  - **Memory:** 64 MB of SQLite memory.
  - **Concurrency:** 4 processes at once; the rest queue.
- Dialect: SQLite 3.5x. It has RIGHT / FULL JOIN, window functions, CTEs and `strftime` for dates.
- Comparison is done on tables, never on text: column names (case-insensitive), values (numbers within 1e-6, NULL only
  equals NULL, a number never equals text) and duplicate rows. Row order is checked only when the question asks for it.

## 5. Setup

1. Apply the migration `20261104100000_sql_round`, which adds the `sql_questions` table and the
   `round_questions.sql_spec` column (additive). Run `pnpm --filter api db:deploy` on the target database.
2. No new service to run: SQLite is part of Node.js. It needs a current release with the `node:sqlite` authorizer
   (tested on Node 26). An older Node refuses to run queries rather than run them unlocked.
3. Env (all optional): `FEATURE_SQL`, `SQL_RUNNER_CONCURRENCY`, `SQL_RUNNER_HEAP_MB` (see `.env.example`). The DSA
   settings also apply: `DSA_ROUNDS`, `CANDIDATE_APP_URL`, `DSA_PROCTOR_MAX_STRIKES`.
4. HR: **SQL questions → Add the 15 starter questions**. Then in a job's rounds editor, add a SQL round with
   coding questions from the bank, set the time limit and pass rule, and mark the rounds complete.

## 6. Tests

`apps/api/tests/sql/`:
- **Engine:** real JOIN / GROUP BY / HAVING / subquery / UNION / RIGHT JOIN / window queries; every destructive
  statement refused; multi-statement input; syntax errors; endless query killed while the API stays responsive; row
  limit; table comparison rules.
- **Starter questions:** all 15 run. Each has at least 2 sample and 3 hidden datasets, and a typical wrong answer
  fails each one (e.g. `NOT IN` meeting a NULL, missing `DISTINCT`, `COUNT(*)` on a LEFT JOIN).
- **Bank service:** CRUD, 422 with reasons, company isolation, starter import, audit.
- **Whole round:** HR round → `roundKind` CODING after aptitude → email wording → the candidate sees tables and samples
  but no hidden data or reference query → Run / Submit → grading and the outcome email → two warnings then the
  attempt ends.
- **HTTP routes and app wiring:** the real `AppModule` builds.

Also `packages/contracts/tests/sql-bank.test.ts` and `apps/hr-dashboard/tests/sql-bank.test.ts`.

Not verified: the pages in a browser (type-checked and unit-tested only), and the migration on a real database (the
schema diff matches the migration exactly).
