# applications

| | |
|---|---|
| **Owner** | Intern 3 (Candidate & Comms) |
| **Doc modules** | M08 Unified apply link (API side), M09 Applications intake |
| **Release** | v0.1 |

Public job data for the careers site, phone OTP, and the application intake. Resume FILES go to the S3 bucket
(`RESUME_STORAGE=s3`); PostgreSQL keeps only the record (name, size, sha256, scan result, `storage_key`).
Full guide: [docs/M06_M09_PUBLISH_AND_APPLY.md](../../../../../docs/M06_M09_PUBLISH_AND_APPLY.md).

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).

## Files
| File | What it does |
|---|---|
| `public-careers.controller.ts` | public endpoints under `/api/v1/public` |
| `applications.service.ts` | intake: form → job LIVE? → phone verified? → file type/size → virus scan → dedupe (phone, or the email typed on the application) → save |
| `otp/` | phone OTP (only an HMAC of the code is stored), signed short-lived phone proof, dev sender |
| `resume/file-check.ts` | PDF / DOCX detection from file content (magic bytes; DOCX = ZIP whose central directory lists `[Content_Types].xml` + `word/document.xml`), 5 MB limit, safe file name |
| `resume/virus-scanner.ts` | ClamAV (clamd INSTREAM, verified against `clamav/clamav:stable`) or `dev-eicar-only` for local demos. Fails closed |
| `hr-applications.controller.ts` / `.service.ts` | HR view (login + `jobs.read`): `GET /api/v1/applications/jobs/:jobId` lists a job's applications; `GET /api/v1/applications/:applicationId/resume` downloads the resume (always `attachment`, `no-store`, audited as `application.resume_downloaded`). Scoped to the session's company: another company's id is a 404. Dashboard page: `/applications` |
| `my-data.service.ts` | DPDP view / erase, proven by a fresh phone OTP; audited in `applications_audit_events` |
| `abuse/rate-limiter.ts` | per-IP limits on every public POST, sized for a whole college on one Wi-Fi IP; `PUBLIC_RATE_LIMITS` overrides (in-memory; Redis when the API runs on several instances). `rateLimit()` guard on the upload, so the limit is checked before the body is read |
| `email/email-queue.ts` | "thanks for applying" emails in the background (2 at a time; retries network errors and SMTP 4xx replies; wrong SMTP login logged as an error; `cancel(key)` drops a candidate's unsent emails), so submit never waits for the mail server |
| `abuse/captcha.ts` | Cloudflare Turnstile on "send OTP" when `TURNSTILE_SECRET_KEY` is set (VERIFY against Cloudflare docs) |
| Feature flag | `FEATURE_APPLICATIONS=off` switches all `/public/*` routes off |
| `resume/resume-storage.ts` | where resume files live: AWS S3 (`RESUME_STORAGE=s3`, key `<tenantId>/resumes/<resumeId>.pdf`, SSE-AES256) or, local dev only, the `resume_files` table. Upload happens before the DB transaction; the file is deleted again if the record is not saved; DPDP erase deletes it too |
| `src/cli/move-resumes-to-storage.ts` | `pnpm --filter api resumes:to-storage`: moves resumes saved in `resume_files` to the bucket (safe to re-run) |
| DB | `apps/api/prisma/schema/applications.prisma` + view `parser_resume_inbox` (migration SQL) |

## Endpoints (public, no login)
| Method | Path | Purpose |
|---|---|---|
| GET | `/public/:companySlug/jobs` | live jobs of a company |
| GET | `/public/:companySlug/jobs/:jobSlug` | approved JD for the job page |
| POST | `/public/otp/send` | `{ companySlug, phone }` (30 s resend gap, 5 per hour) |
| POST | `/public/otp/verify` | `{ companySlug, phone, code }` → `{ otpToken }` (5 tries per code) |
| POST | `/public/applications` | multipart: `companySlug`, `jobSlug`, `application` (JSON), `resume` (file) |
| POST | `/public/my-data` | `{ companySlug, phone, otpToken }` → the student's own data (DPDP access) |
| POST | `/public/my-data/delete` | `{ ..., confirm: true }` → erase candidate, applications, resumes, consents (DPDP) |
| GET | `/public/config` | `{ captchaRequired }` for the careers site |

## For the resume parser (M10)
Read new resumes from the view **`parser_resume_inbox`** with a login in role **`hireflow_resume_reader`**
(see `scripts/demo-m06-m09/create-parser-login.sql`). That role can only `SELECT` the view - it cannot read
or change the tables. Only virus-scanned resumes appear.

Poll with an **overlap**: `created_at` is set when the intake transaction starts, but the row only appears when it
commits (up to ~30 s later when many students apply at once). "Remember the last `created_at`" alone skips those late
rows. Instead:

```sql
SELECT * FROM parser_resume_inbox
WHERE created_at > $last_seen - interval '2 minutes'
ORDER BY created_at
LIMIT 50;
```

and skip every `resume_id` you already processed (keep processed ids, e.g. a unique column in your own table).
`last_seen` = the highest `created_at` you processed.

## Many students at once
Measured locally (one API instance, 200 KB resumes): 1000 students applying within 3 s, all saved; 300 within 2 s,
all saved and all 300 confirmation emails sent within 30 s. What makes that work:
- Real student IP: the API takes `X-Forwarded-For` only from proxies matching `TRUST_PROXY` (default `loopback` = the
  careers site on this machine; `true`/`false`/hop count/subnet also work). The careers site's middleware sets that
  header from `TRUSTED_CLIENT_IP_HEADER` (`cf-connecting-ip` behind Cloudflare / a Cloudflare tunnel, `x-real-ip` behind
  nginx) and otherwise REMOVES it, so a student cannot pick their own IP. Without `TRUSTED_CLIENT_IP_HEADER` every student
  coming through the careers site counts as one IP (fine for local dev; set it for a real drive). Requirements: the
  careers site must be reachable only through that edge (bind it to localhost / firewall it) - anyone reaching it
  directly can send the trusted header themselves; and the API port must not be public.
- Campus drive: everyone on one college Wi-Fi shares an IP. Defaults allow 300 applications per IP per hour; raise
  for big drives, e.g. `PUBLIC_RATE_LIMITS=otp-send=2000,otp-verify=6000,application=2000`.
- The intake transaction waits up to 30 s for a DB connection (Prisma's 2 s default failed ~13% at 200 parallel).
- Emails are queued in memory: if the API stops, queued emails are lost (`confirmation_email_sent_at` stays empty).
  Gmail has a daily sending limit (commonly ~500 for free accounts, VERIFY in Google's docs); use a real email
  provider for big drives.

## Not yet / hand-offs
- No real SMS provider (needs DLT registration in India). `OTP_PROVIDER=dev` shows the code on screen; refused in production.
- `application.received` is logged, not published (M30 event bus not built yet).
- Data deletion is per company and proven by phone OTP (no candidate login yet). Other modules (M10/M11) must also delete their copies once they store any.
