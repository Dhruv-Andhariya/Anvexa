# publisher

| | |
|---|---|
| **Owner** | Intern 3 (Candidate & Comms) |
| **Doc modules** | M06 Job publisher, M07 Channel adapters |
| **Release** | v0.1 (careers page + LinkedIn company page), more channels v1.3 |

Takes an **approved** JD and posts one student-friendly post per channel, in parallel.
Full guide: [docs/M06_M09_PUBLISH_AND_APPLY.md](../../../../../docs/M06_M09_PUBLISH_AND_APPLY.md).

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).

## Files
| File | What it does |
|---|---|
| `publisher.controller.ts` | HR endpoints under `/api/v1/publisher` (company from the login session, M28 permissions) |
| `publisher.service.ts` | approved JD from the DB → preview → publish every channel in parallel, retries, no double posting |
| `post-formatter.ts` | builds the post ONLY from the approved JD + job form + company profile; exactly 2 links |
| `publisher.store.ts` | all DB access, always scoped by `tenant_id`; reads Intern 1's `job_approvals`, `jd_versions`, `tenants`, `company_profiles` (never writes them) |
| `channels/` | M07 adapters: `careers-site`, `linkedin` + the coming-soon list |
| `linkedin-oauth.ts`, `linkedin-connect.*.ts` | M07 "Connect LinkedIn" (OAuth authorization code flow, state cookie, callback) |
| `channel-credentials.ts` | M07 `channel_credentials`: per-company OAuth tokens, AES-256-GCM encrypted with `ENCRYPTION_KEY` (`common/secret-box.ts`) |
| `jd-checks.ts` | basic publish checks + calls the M03 validator (`AI_WORKER_URL/v1/jd/validate`) |
| `public-jobs.reader.ts` | read-only access for the careers site / apply flow (exported via `index.ts`) |
| `publisher.events.ts` | `job.published` / `job.publish_failed` (logged until the M30 event bus exists) |
| Audit | every HR action → Intern 1's `audit_logs` via `AuditService` (ids/statuses only, actor = logged-in user) |
| Feature flag | `FEATURE_PUBLISHER=off` switches all `/publisher/*` routes off (404 `FEATURE_DISABLED`) |
| DB | `apps/api/prisma/schema/publisher.prisma` |

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/publisher/channels` | live + coming-soon channels for this company |
| GET | `/publisher/jobs` | every APPROVED job with listing, per-channel status, application count |
| POST | `/publisher/jobs/:jobId/preview` | body `{ selectionProcess }` → text of every post, errors, warnings. Saves nothing |
| POST | `/publisher/jobs/:jobId/publish` | publishes the approved version. Twice = no second post |
| POST | `/publisher/jobs/:jobId/retry` | re-try FAILED / NOT_CONFIGURED channels with the current approved version (basic publish checks run again) |
| POST | `/publisher/jobs/:jobId/close` | stop applications (careers page shows closed; adapters with `close()` take posts down) |
| POST | `/publisher/jobs/:jobId/reopen` | take applications again (422 `DEADLINE_PASSED` once the last date to apply is over) |
| DELETE | `/publisher/jobs/:jobId` | "Delete": take the job off the careers page and delete its LinkedIn post; the job goes back to "Not published" (still approved, can be published again as a fresh post). Applications are kept. Posts that could not be removed come back in `notRemoved` (409 `PUBLISH_IN_PROGRESS` while a channel is posting) |
| POST | `/publisher/jobs/:jobId/refresh-links` | "Update apply link in posts": edits the posts already made (same post, likes kept) so their text carries the CURRENT apply link (`CAREERS_SITE_URL`) - use after the public careers-site URL changed (temporary tunnel restarted). LinkedIn: `PARTIAL_UPDATE` of `commentary`. Posts that could not be edited come back in `notUpdated` with their link. Also runs by itself at API start for every job whose careers-page row was saved under an older `CAREERS_SITE_URL` (off with `PUBLISHER_AUTO_REFRESH_LINKS=false`); a job it could not finish shows `listing.linksOutdated` on the HR board and is tried again at the next start |
| GET | `/publisher/jobs/:jobId/posts` | per-channel status |
| PUT | `/publisher/channels/:channel/settings` | Company Admin: `{ enabled, config }` e.g. LinkedIn `{ "organizationId": "12345678" }` |
| GET | `/publisher/linkedin/connect` | Company Admin, browser link: redirects to LinkedIn's consent screen |
| GET | `/publisher/linkedin/callback` | LinkedIn redirects here (`LINKEDIN_REDIRECT_URI`); saves the token, redirects to `/publish?linkedin=<result>` |
| DELETE | `/publisher/linkedin/connection` | Company Admin: forget the stored LinkedIn token |

## Add a new platform
1. Write `channels/<name>.adapter.ts` implementing `ChannelAdapter` (`render`, `blockers`, `publish`).
2. Add one line to `channelAdaptersProvider` in `channels/index.ts` and remove it from `COMING_SOON_CHANNELS`.
3. Add a test with a fake `fetch`. No other file changes.

## Not yet / hand-offs
- Editing an already-PUBLISHED LinkedIn post on a new JD version is not done (the careers page updates itself). Publishing again returns `unchanged: true` for such posts and the dashboard says so.
- LinkedIn token: per company via "Connect LinkedIn" (encrypted in `channel_credentials`). `LINKEDIN_ACCESS_TOKEN` env is a fallback for ONE company only: set `LINKEDIN_FALLBACK_TENANT_ID` to its tenant id (unset = fallback off). A company that has its own connection never uses the env token, even when its token expired or cannot be decrypted ("reconnect" blocker). No automatic refresh yet: when the token expires (~60 days) the dashboard shows "expired" and the admin reconnects. The refresh token is already stored for that next step.
- This is a LinkedIn company-page POST, not a LinkedIn Jobs listing (Jobs API is partner-only).
- Closing does not emit `job.closed` (that event belongs to the M29 orchestrator). No LinkedIn take-down yet (`close()` not implemented for LinkedIn).
- No Grafana metrics: the repo has no metrics stack yet (doc 15.3).
- VERIFY before launch: LinkedIn Posts API details listed in `channels/linkedin.adapter.ts`.
- No duplicate LinkedIn posts: `POST /rest/posts` is retried automatically only when the request surely never reached LinkedIn (connection refused / DNS, 429). Timeouts, resets and 5xx are `FAILED` with "check the LinkedIn page before retrying".
- Slugs: `<title>-<last 6 hex of job id>`; if that is taken in the company, the full job id hex is used. A published slug never changes.
