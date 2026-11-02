# ats

| | |
|---|---|
| **Owner** | Intern 2 (AI) - built together with Intern 3 (M06-M09) |
| **Doc modules** | M10-M11 (API side) |
| **Release** | v0.1 |

Orchestrates resume parsing + scoring by calling the Python AI worker; stores the results (tables in
`prisma/schema/ats.prisma`). Everything here is HR-only - nothing is ever served by a public API.

## Built so far
| Part | Files |
|---|---|
| Private minimum ATS score per job (`job_screening_settings`) | `screening-settings.*` |
| Background resume parsing + ATS scoring (`ats_evaluations`) | `ats-processor.service.ts`, `ats-worker.client.ts` |
| HR decisions + decision emails (`candidate_emails`, `screening_invites`) | `decision.*`, `decision-email.sender.ts`, `emails/`, `screening-link.ts` |

### Minimum ATS score
- HR enters it on the new-job form; `POST /jobs` takes it as `screening: { minAtsScore }` next to the form fields and
  saves it HERE, never in `jobs.form_data` (the form is part of the public careers API).
- `GET / PUT /api/v1/ats/jobs/:jobId/settings` (`jobs.read` / `jobs.write`, own company only, feature flag `ats`).
  Changing it re-sorts candidates HR has not decided on or emailed yet.
- A job cannot be published without it (publisher check). A database without the ATS migration answers 503
  `ATS_NOT_READY` here and does not block publishing.

### Background screening
- Every application gets one `ats_evaluations` row (the loop queues new applications itself, so applying stays fast
  and nothing in the intake changed). The loop claims due rows with `FOR UPDATE SKIP LOCKED` - one row is never
  screened twice, also with several API processes - and a claim older than 15 minutes is taken over.
- The worker reads the resume against the **JD version the student applied to** and returns the parsed resume and
  an explainable score; the job's minimum ATS score gives `system_decision` (SHORTLISTED / NOT_SHORTLISTED, null
  while HR has not set a score).
- A technical error is never a rejection: network / AI busy / quota / old worker -> retried after 1, 5, 15, 60 min;
  after 5 tries, or for an unreadable file, the row is `NEEDS_REVIEW` for HR.
- Env: `ATS_PROCESSING`, `ATS_POLL_MS`, `ATS_CONCURRENCY`, `ATS_WORKER_TIMEOUT_MS` (see `.env.example`).
- Without the migration the loop logs "ATS tables are missing" once and checks again every 5 minutes.

### HR decisions and decision emails
- The ATS only suggests (`system_decision`). HR can override it (`PUT /ats/applications/:id/decision`,
  `hr_decision` wins) until a decision email was sent.
- **Rejection emails are automatic** (`AUTO_REJECTION_EMAILS`, default on, `auto-rejection.ts`): a screened
  candidate below the job's minimum - right after screening, after HR raises the minimum, or when HR picks "not
  shortlisted" - gets the rejection email at once. A resume that could not be screened (NEEDS_REVIEW / pending)
  never does. **Shortlist emails are automatic too** (`AUTO_SHORTLIST_EMAILS`, default on, same file): a screened
  candidate at or above the minimum - right after screening, after HR lowers the minimum, or when HR picks
  "shortlisted" - gets the shortlist email with their AI screening link at once. Only with a PUBLIC screening link
  (not localhost); otherwise, or with `AUTO_SHORTLIST_EMAILS=off`, HR sends them (`POST /ats/emails { kind,
  applicationIds }`, also used to send a FAILED email again); each candidate is checked on their own. One decision
  email per candidate (unique `application_id`), also when two HR users click at once.
- `DecisionEmailSender` sends in the background (same claim pattern): network / SMTP 4xx retried 3 times, then
  `FAILED` (HR can send again). Templates: `emails/decision-emails.ts` (the agreed wording). Several APIs can share
  one database (teammates' laptops on Neon): an API whose screening link is localhost does not claim shortlist
  emails at all, so the API with the public (tunnel) link sends them at once. Safety net (`queueMissedShortlists`,
  every minute while `AUTO_SHORTLIST_EMAILS` is on): any shortlisted, screened candidate without a decision email
  gets the shortlist email queued.
- Shortlist emails need `AI_SCREENING_URL` (the M12 page, not built yet) and are refused with 409
  `SCREENING_LINK_NOT_SET` until then. Each email gets a fresh token; only its SHA-256 is stored in
  `screening_invites`, valid 7 days from the send time. A link that was never delivered is deleted.
- `POST /ats/applications/:id/retry` sends a resume in HR review back to screening.

## Rules for this folder
- Other modules may import this module ONLY through `index.ts` - or `settings.ts`, the settings-only entry used by
  jobs and publisher (importing `index.ts` there would make an import circle through applications).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).
