# M06–M09: Publish a job and take applications

How the **Job publisher (M06)**, **Channel adapters (M07)**, **Apply page (M08)** and **Applications intake (M09)**
work, where the code is, how to run and test it, and what is still open. Owner: Intern 3.

## 1. The flow

```text
Intern 1 (M01-M04, not part of this module)
  HR logs in → company profile (with careers page link) → job form → AI JD → HR approves
  → jobs.status = APPROVED, job_approvals → jd_versions (immutable)
        │
        ▼
HR dashboard /publish                        apps/hr-dashboard/src/app/publish   (+ "Publish this job →" on /jobs/:id)
  every APPROVED job → [Preview & publish] → selection process + preview of every channel → [Confirm & publish]
        │  GET  /api/v1/publisher/jobs
        │  POST /api/v1/publisher/jobs/:jobId/preview   (saves nothing)
        │  POST /api/v1/publisher/jobs/:jobId/publish
        ▼
publisher (M06)                              apps/api/src/modules/publisher
  1. reads the APPROVED version from the database (job_approvals → jd_versions) - never a client copy, never a draft
  2. company = tenants + company_profiles (name, about, careers_url); checks: JD rules + M03 validator + careers link
  3. publisher_job_listings points at that approved version (stable public link)
  4. publishes every enabled channel IN PARALLEL                job_posts (1 row per job per channel)
        ├─ careers      our careers site (always available)
        ├─ linkedin     post on the company's LinkedIn page (Posts API) - waits for API access
        └─ naukri, indeed, instagram, facebook, x, whatsapp → "coming soon"
        ▼
careers-site /[company]/jobs/[job]           apps/careers-site   (M08)
  full JD (server HTML) + company careers link + apply form: details, phone OTP, resume, consent
        │  POST /api/v1/public/otp/send · /otp/verify · /applications (multipart)
        ▼
applications (M09)                           apps/api/src/modules/applications
  form ✓ → job LIVE ✓ → phone verified ✓ → PDF/DOCX + ≤5 MB ✓ → virus scan ✓ → not a duplicate ✓
  → resume file uploaded to the S3 bucket (RESUME_STORAGE=s3; key <tenantId>/resumes/<resumeId>.pdf|.docx)
  → one transaction: candidates, applications (+ jd_version_id), resumes (record + storage_key), consents
    (resume_files only when no cloud storage is configured - local dev)
  → "thanks for applying" email (application id, job id, reference HF-XXXXXXXX, links) via SMTP
        ▼
resume parser (M10, Intern 2) reads view parser_resume_inbox as role hireflow_resume_reader (read-only)
```

## 2. The post

Built only from the approved JD + job form + company profile (`post-formatter.ts`). A line is **left out** when its
data is missing - nothing is invented. Order: company + role, location, salary in plain words (`₹4 – 6 LPA (CTC)`),
who can apply (from the experience range), what the job is, what you will do, skills, selection process (only what
HR typed), about the company, last date to apply, then **exactly two links**: *Apply here* (our careers page, with
`?src=<channel>`) and *Company careers page* (`company_profiles.careers_url`). Any URL inside AI-written text is
removed so the two links stay the only links. No careers page link → publishing is refused with a clear message.

## 3. Guarantees and how they are enforced

| Rule | How |
|---|---|
| Only approved versions are published | The request body has only `selectionProcess`; the JD is read from `job_approvals → jd_versions` of an `APPROVED` job |
| One channel failing never stops others | `Promise.all` over channels, each wrapped; adapter errors become `FAILED` for that channel only |
| Never post the same job twice | unique `(tenant_id, job_id, channel)` + atomic claim (`PENDING/FAILED → PUBLISHING`, only while the listing is `LIVE`, so a concurrent close wins) |
| Retries | only errors where nothing can have been posted (connection refused, 429) are retried 3× with backoff. A LinkedIn timeout / 5xx is `FAILED` with "check the LinkedIn page before retrying" (the post may exist). `POST /publisher/jobs/:id/retry` for later; it runs the basic publish checks again (deadline, empty JD) |
| Companies kept apart | HR routes: company from the login session (Intern 1's `TenantContext`); public routes: company from its slug; every query filters by `tenant_id` |
| Who may publish | `jd.approve` permission (publish, retry, close, reopen, delete); `company.update` (Company Admin) for LinkedIn settings |
| No secrets / personal data in logs | logs carry ids only; LinkedIn errors never include request details; OTPs never logged or stored (HMAC only); email address/body never logged |
| Unsafe files never saved | type from file content (magic bytes), 5 MB limit, ClamAV scan, **fail closed** if the scanner is down |
| Email never loses an application | queued after the transaction commits (in memory, 2 at a time; network errors and SMTP 4xx "try later" replies are retried, a wrong SMTP login is logged as an error); failure only leaves `confirmation_email_sent_at` empty. The receipt (`confirmationEmailSent: true`) means *queued*, and the page says "we will email you" |
| Spam protection | per-IP rate limits on every public POST (on the upload: a guard, checked before the 5 MB body is read); the careers site sets `X-Forwarded-For` only from a trusted edge header (see *Real student IP* below); Cloudflare Turnstile on "send OTP" when keys are set; CSRF header on every write; "send code" is serialised per phone (`pg_advisory_xact_lock`) so parallel clicks cannot beat the 30 s / 5-per-hour limits |
| One application per job | same phone: unique `(tenant_id, job_id, candidate_id)`; same email: `applications.email` (the email typed on that application, lower-case by CHECK) unique per `(tenant_id, job_id)`. A lost race answers 409 `ALREADY_APPLIED`; the same new phone applying to two jobs at once is retried, not refused |
| Student data rights (DPDP) | `/[company]/my-data`: verify phone → see data → delete everything (one transaction, candidate row locked `FOR UPDATE`, audited; queued confirmation emails are cancelled). If a new row still points at the data, nothing is deleted and the student gets 409 `DELETE_CONFLICT` "try again" |
| HR can stop a job | Close / Reopen on the Publish page; closed jobs refuse applications with 410. A job whose last date to apply has passed is closed for students (left out of the careers list, shown "Closed · deadline passed" to HR) and cannot be reopened (422 `DEADLINE_PASSED`). **Delete** removes the job from the careers page and deletes the LinkedIn post (`DELETE /rest/posts/{urn}` - VERIFY); the job stays approved and can be published again as a new post; applications are kept |
| Switch off without deploy | `FEATURE_PUBLISHER=off`, `FEATURE_APPLICATIONS=off` |
| Audit trail | Intern 1's `audit_logs`: `job.published`, `job.publish_retried`, `job.closed`, `job.reopened`, `job.unpublished`, `publisher.channel_settings_updated`, `candidate.data_viewed/deleted` (ids, statuses, counts only) |
| Parser cannot change data | view `parser_resume_inbox` + role `hireflow_resume_reader` with `SELECT` on the view only |
| Parser misses no resume | `created_at` is set when the intake transaction starts but the row appears at commit (up to ~30 s later under load), so the parser polls with an overlap - `created_at > last_seen - 2 minutes` - and skips `resume_id`s it already processed |

## 4. Run it

```bash
pnpm infra:up                              # Postgres, Redis, Mailpit
pnpm install && pnpm --filter api db:deploy
pnpm dev                                   # API :4000, HR dashboard :3000, careers site :3300
pnpm demo:m06-m09                          # whole flow from "approved JD" to "resume in the parser view"
pnpm demo:m06-m09 --keep                   # same, but leaves the application in the database
```

Demo HR login: `demo.hr@hireflow.local` / `demo-password-123` → http://localhost:3000/publish. Emails: http://localhost:8025.
If the AI worker cannot generate a JD, the demo inserts the ready-made one from `scripts/demo-m06-m09/demo-job.json`.

Environment (see `.env.example`, block "M06-M09"): `CAREERS_SITE_URL`, `SMTP_URL`, `MAIL_FROM`, `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_FALLBACK_TENANT_ID`,
`LINKEDIN_API_VERSION`, `OTP_PROVIDER`, `OTP_SIGNING_SECRET`, `VIRUS_SCANNER` (`clamav` | `dev-eicar-only`),
`CLAMAV_HOST/PORT`, `TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `FEATURE_PUBLISHER`, `FEATURE_APPLICATIONS`,
`PUBLIC_RATE_LIMITS`, `TRUST_PROXY` (API) and `TRUSTED_CLIENT_IP_HEADER` (careers site).

**Real student IP (per-IP limits).** Students reach the API through the careers site's `/api/v1/public/*` proxy. Next's
proxy adds no `X-Forwarded-For` and passes the visitor's own one through, and the API trusts that header from the careers
site (`TRUST_PROXY=loopback`). So `apps/careers-site/src/middleware.ts` rewrites it: from `TRUSTED_CLIENT_IP_HEADER`
(`cf-connecting-ip` behind Cloudflare or a Cloudflare tunnel, `x-real-ip` behind nginx, `x-forwarded-for` = last entry
from one proxy) or, when that is empty (local dev), removes it - then every visitor counts as one IP. Deployment
requirements: the careers site must be reachable **only** through that edge (bind it to localhost / firewall it),
otherwise anyone can send the trusted header themselves; the API must not be reachable from outside except through the
careers site or a proxy covered by `TRUST_PROXY`. `TRUST_PROXY=true` trusts every hop - only when nothing can reach the
API directly.
Real ClamAV: `docker compose -f infra/docker/docker-compose.yml --profile security up -d clamav`, then `VIRUS_SCANNER=clamav`.

## 5. Tests

```bash
pnpm --filter api test                     # unit tests (no DB needed)
TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow_test pnpm --filter api test   # + real-DB flow (signup → approve → publish → apply → delete)
CLAMAV_TEST_HOST=localhost pnpm --filter api test   # + real ClamAV (docker --profile security up -d clamav)
pnpm --filter careers-site test
pnpm --filter hr-dashboard test
pnpm --filter @hireflow/contracts test
```

## 6. Interim pieces (replace when the owner ships)

| Interim | Real owner | What changes |
|---|---|---|
| events logged, not published | M30 event bus (Intern 1) | `PublisherEvents` / intake write to the outbox |
| selection process typed by HR | M05 round config | taken from `job_round_configs` |
| plain-text/HTML confirmation email in `applications/email` | M24 email templates | move to `packages/email-templates` |

## 7. LinkedIn: what is needed once API access is approved

1. A LinkedIn app with the **Community Management API** product, and an access token of a **page admin** with scope `w_organization_social`.
2. Connect LinkedIn per company with the dashboard button (preferred), or for a single-company setup set `.env`:
   `LINKEDIN_ACCESS_TOKEN=<token>` + `LINKEDIN_FALLBACK_TENANT_ID=<that company's tenant id>` (the env token is used for
   no other company, and never for a company whose own connection expired). Always set
   `LINKEDIN_API_VERSION=<YYYYMM from LinkedIn's docs>`; restart the API.
3. HR dashboard → Publish → *LinkedIn company page* (Company Admin): enter the page's numeric organization id.
4. Publish a job (or *Retry failed channels* on one that shows "Not set up") and check the post on the page.

VERIFY before going live (not guessed): endpoint `POST /rest/posts`, headers `LinkedIn-Version` +
`X-Restli-Protocol-Version: 2.0.0`, post id in `x-restli-id`, "little text" escaping, 3000-char limit, and **token
expiry** (tokens expire; there is no refresh flow yet - a 401 shows as "LinkedIn rejected the post (401)", fix by
setting a new token). This posts on the company page; real LinkedIn *Jobs* listings need the partner program.

## 8. Other outside services to verify before launch

- **SMTP provider**: pick one for production, set `SMTP_URL` + `MAIL_FROM` on a domain with SPF/DKIM.
- **ClamAV**: verified on 2026-10-13 against `clamav/clamav:stable`. Re-check if you change the version.
- **SMS OTP**: choose a provider and finish DLT registration (India); only the dev sender exists.
- **Cloudflare Turnstile**: siteverify request/response and the widget script (see `abuse/captcha.ts`, `components/phone-verify.tsx`).
- **DPDP**: have a lawyer review the consent text in `apps/careers-site/src/content.ts`.
