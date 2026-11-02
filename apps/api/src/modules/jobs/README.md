# jobs

| | |
|---|---|
| **Owner** | Intern 1 (Core & HR) |
| **Doc modules** | M01-M04 |
| **Release** | v0.1 |

Job form, JD versions, validation result storage, HR approval. Calls the AI worker for JD generation/validation.

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).

## Implemented (steps 2-4 of the JD flow — see [docs/JD_WORKFLOW.md](../../../../../docs/JD_WORKFLOW.md))

Status: `DRAFT` (no current JD) → `JD_GENERATED` (current version waiting for HR) → `APPROVED` (locked).
Changing the requirements (`PATCH /jobs/:id` with a different form) clears the current version and sets the job
back to `DRAFT`: the old JD was written from the old requirements, so it cannot be approved. Its versions stay in the history.

| Method | Path | Body | Does |
|---|---|---|---|
| POST | `/api/v1/jobs` | `JobForm` | Step 2: save a `DRAFT` job. `409 COMPANY_PROFILE_REQUIRED` if step 1 is not done |
| GET | `/api/v1/jobs` | | List, newest first (`JobSummary[]`) |
| GET | `/api/v1/jobs/:id` | | `JobDetail`: form, every JD version (newest first), approval |
| PATCH | `/api/v1/jobs/:id` | `JobForm` | Change the requirements (not after approval); a real change → `DRAFT`, regenerate next |
| POST | `/api/v1/jobs/:id/jd/generate` | | Step 3: job form **+ saved company profile** → AI worker → new `AI` version |
| PATCH | `/api/v1/jobs/:id/jd` | `{ baseVersionId, basedOnVersionId?, content }` | Step 4: HR edit → new `HR_EDIT` version. A restore sends `basedOnVersionId` (the restored version) so its company details are kept |
| POST | `/api/v1/jobs/:id/approve` | `{ jdVersionId, companyDetailsVerified: true, note? }` | Step 4: approve the current version, lock the job. The approver is the logged-in user. `422 JD_INCOMPLETE` if the version fails the edited-JD checks (e.g. blank summary) |

- Tables (`apps/api/prisma/schema/jobs.prisma`): `jobs`, `jd_versions` (never updated — every generation
  or edit is a new row, with the `company_snapshot`, `prompt_version` and `model` it came from), `job_approvals`.
- Concurrency: edits and approvals name the version they are based on. If another tab wrote a newer
  version first, the API answers `409 STALE_JD_VERSION` instead of overwriting it.
- Errors: `{ statusCode, code, message }`. `400 INVALID_JOB_FORM` / `INVALID_JD` / `INVALID_APPROVAL`
  (with `issues[]`), `404 JOB_NOT_FOUND` / `JD_VERSION_NOT_FOUND`, `409 JOB_APPROVED` / `STALE_JD_VERSION` / `JD_NOT_GENERATED`,
  `422 JD_INCOMPLETE` / `INVALID_COMPANY_PROFILE` (saved profile no longer valid - fix it before generating).
  AI errors (`LLM_*`, 422/429/502/503/504) pass through with safe messages (a 429 adds `retryAfterSeconds` when the worker sent `Retry-After`); `503 AI_WORKER_UNAVAILABLE`,
  `504 AI_WORKER_TIMEOUT`, `502 AI_WORKER_ERROR` / `AI_WORKER_INVALID_RESPONSE`. A failed generation stores nothing.
- Access (M28): every route needs a logged-in member of an ACTIVE company with the matching permission
  (`jobs.read`, `jobs.write`, `jd.generate`, `jd.edit`, `jd.approve`; see `auth/permissions.ts`).
  The company comes from the session (`TenantContext`), never from the request; another company's job id is a `404`.
  `jd_versions` / `job_approvals` reference `jobs(id, tenant_id)`, so the database also rejects cross-company rows.
- Who: `jobs.created_by_id`, `jd_versions.created_by` and `job_approvals.approved_by_id` hold the user id
  (NULL for rows written before login existed). `approvedBy` is the user's name from the session.
- Audit: `job.created`, `jd.generated`, `jd.edited`, `job.approved` (`audit_logs`).
- Tests: `apps/api/tests/jobs.test.ts` (in-memory repositories, fake worker, no database needed) and
  `apps/api/tests/multi-company.e2e.test.ts` (real database, two companies; see the auth README).

## Not yet
- No `job.created` / `jd.approved` events (M29/M30), no M03 validation before approval, no Row Level Security.
