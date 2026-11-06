# ANVEXA

AI-powered hiring platform: from "HR has an opening" to "candidate sits in the final interview".

- **Start here:** [`docs/TEAM_GUIDE.md`](docs/TEAM_GUIDE.md) — setup, who owns what, git workflow
- **Full project documentation:** [`docs/ANVEXA_Documentation.md`](docs/ANVEXA_Documentation.md)
- **Publish & apply guide (M06–M09):** [`docs/M06_M09_PUBLISH_AND_APPLY.md`](docs/M06_M09_PUBLISH_AND_APPLY.md)
- **Assessment rounds guide (M05, HR side + round engine wiring):** [`docs/ASSESSMENT_ROUNDS.md`](docs/ASSESSMENT_ROUNDS.md)
- **DSA coding round (HR setup, invitation, coding page, results):** [`docs/DSA_ASSESSMENT_ROUND.md`](docs/DSA_ASSESSMENT_ROUND.md)

---

## What works today (v0.1)

The first half of the hiring flow works end to end:

```
HR signs up ─► registers company ─► creates job ─► AI writes JD ─► HR edits & approves
   ─► HR picks assessment rounds + questions + pass marks (saved per job)
   ─► publish (careers page + LinkedIn) ─► student opens Apply link ─► verifies phone ─► uploads resume
   ─► application saved + "thanks for applying" email ─► HR sees applications & downloads resumes
   ─► round results (from the round engine) on the HR Assessments page
```

| Part | Where | Status |
|---|---|---|
| HR login, teams, roles | `apps/api/src/modules/auth`, `apps/hr-dashboard` | ✅ Built |
| Companies (multi-tenant) | `apps/api/src/modules/tenants` | ✅ Built |
| Job form → AI JD → approval | `apps/api/src/modules/jobs`, `workers/ai-worker` | ✅ Built |
| Publishing (careers page + LinkedIn) | `apps/api/src/modules/publisher` | ✅ Built |
| Apply link + application intake | `apps/careers-site`, `apps/api/src/modules/applications` | ✅ Built |
| Assessment rounds (HR picks rounds, questions, pass marks on the Publish page) | `apps/api/src/modules/rounds-config`, `apps/hr-dashboard/src/components/rounds` | ✅ Built |
| Assessments page (round results, pass / fail override) | `apps/api/src/modules/assessments`, `apps/hr-dashboard/src/app/assessments` | ✅ Built (waits for results from the round engine) |
| Audit log | `apps/api/src/modules/audit` | ✅ Minimal (write only, no UI) |
| Resume parsing / ATS scoring | `workers/ai-worker` | 🟡 Mock endpoints (fixed shapes, fake data) |
| Round engine (conducting rounds for students), proctoring, scheduler, evaluator, feedback, notifications, analytics | `apps/api/src/modules/*`, `packages/rounds/*` | ⬜ Empty folders, not started |
| Candidate app, admin console | `apps/candidate-app`, `apps/admin-console` | ⬜ Not started |

---

## Timeline: what we built, day by day

| Date | Commit | What was added |
|---|---|---|
| **9 Oct 2026** | `67c5c53` | Monorepo set up: pnpm + Turborepo, NestJS API, Next.js apps, Python AI worker, Docker infra (Postgres, Redis, Mailpit), shared `packages/contracts`, team guide and folder ownership |
| 9 Oct 2026 | `792ef8e` | Jobs module created |
| **13 Oct 2026** | `6cbc943` | **Module 1: HR input → AI JD generation & validation.** Company profile, job form, Gemini-powered JD generator (prompts v1→v3), rule-based JD validator, JD versions, HR edit + approve |
| **15 Oct 2026** | `7dcf83b` | **Module 2: publish & apply (M06–M09).** Publisher with careers-site channel, public job page + apply form, phone OTP, resume upload with file checks, application intake |
| **22 Oct 2026** | `b2404ff` | **Publishing + authentication.** Google sign-in, email codes for signup and login (2FA), password reset, team invitations, LinkedIn OAuth per company (encrypted tokens), LinkedIn adapter, resumes to S3, background email queue, HR applications page + resume download |
| **23 Oct 2026** | `8d361b3` | Public Apply link moved from **ngrok → Cloudflare quick tunnel** (`scripts/start-public.ps1`) |
| 23 Oct 2026 | `c4cb17d` | LinkedIn post now links to the **company website** (falls back to the careers page if there is no website) |
| 23 Oct 2026 | — | Database moved from local Docker Postgres to **Neon** (cloud Postgres); all data copied over |

---

## What each part does

### 1. Authentication & teams — `auth` (M28)
- Sign up with email + password (email verification code) or **Google sign-in**.
- Login with optional **2FA** (6-digit code by email), **forgot / reset password**.
- Roles: **Company Admin** (everything + company profile + team), **HR Member** (jobs and JDs), **Platform Admin** (oversees all companies, created only by CLI).
- Company Admin invites teammates by email; members can be disabled or have their role changed.
- Secure sessions: httpOnly cookie, CSRF header on every write, rate limits on login/signup.

### 2. Companies — `tenants` (M33)
- Any logged-in user can register a company and becomes its Company Admin.
- Company profile (name, about, website, careers page…) is used when the AI writes JDs and in every post.
- Every query is scoped to the logged-in user's company. Platform Admin can suspend / activate a company.

### 3. Jobs & AI JD — `jobs` + `workers/ai-worker` (M01–M04, M31)
- HR fills the **job form** (title, skills, location, salary, type, deadline…).
- **AI generates the JD** with Google Gemini (prompt `prompts/jd_generate.v3.yaml`) using the job form + company profile.
- Every generation or HR edit is a **new JD version** (history kept, restore possible).
- **Validator** checks the JD is complete before approval / publishing.
- HR **approves** a version, which locks the job.

### 4. Publishing — `publisher` (M06–M07)
- Takes an **approved** JD and posts it to every channel at once:
  - **Careers site** — the company's public job page.
  - **LinkedIn company page** — each company connects its **own** LinkedIn (OAuth); tokens stored AES-256 encrypted.
- Preview before publishing; publishing twice never double-posts.
- Every post carries **exactly two links**: *Apply here* + *Company website*.
- HR can **retry** failed channels, **close** (stop applications), **reopen**, or **delete** (take posts down).

### 5. Apply link & applications — `careers-site` + `applications` (M08–M09)
- Public pages: `/<company>` (all live jobs), `/<company>/jobs/<job>` (full JD + apply form), `/<company>/my-data`.
- Student verifies **phone by OTP**, fills the form, uploads a **PDF/DOCX resume (max 5 MB)**.
- Checks: job still live, real file type, optional virus scan (ClamAV), duplicate applications blocked.
- Resume files go to **S3** (`RESUME_STORAGE=s3`), the database keeps only the record.
- "Thanks for applying" **email** sent in the background.
- **DPDP**: students can view or delete their own data after a fresh OTP.
- Abuse protection: per-IP rate limits, optional Cloudflare Turnstile CAPTCHA.
- **HR side:** `/applications` page in the dashboard lists applicants per job and downloads resumes (audited).

### 6. Assessment rounds — `rounds-config` + `assessments` (M05)
Full guide: [`docs/ASSESSMENT_ROUNDS.md`](docs/ASSESSMENT_ROUNDS.md).
- **Where:** HR dashboard → **Publish** → **Publish** on a job → first step "Assessment rounds". Resume screening and
  AI voice screening are fixed first steps; HR adds the job's own rounds after them.
- HR adds, orders (↑ ↓), renames and removes rounds, and sets a description, time limit and **passing criterion**
  (correct answers, percentage, marks, or interviewer score). The pass mark can never exceed the total.
- Questions per round: own (MCQ, true / false, short answer, descriptive, coding, interview) or **AI-generated**
  (count, difficulty, topics). HR keeps only the AI questions they tick.
- **Save draft** / **Preview posts** write everything straight into the database **for that job**
  (`job_round_configs`, `job_rounds`, `round_questions`). The **Assessments → Assessment Rounds** tab and the round
  engine read the same rows. A job cannot be published until its rounds are complete. Once students start, the rounds lock.
- Public: only the round **names**, in order, as "Selection process" on the careers page and LinkedIn post. Questions,
  answers, pass marks and time limits stay private.
- **Assessments page** (`/assessments`): per job, every shortlisted student × round (status, score), pass / fail
  counts, a full review per student (ATS score, AI voice screening notes, each round's answers), and HR override with a reason.
- **Round engine (teammate):** `RoundsConfigService.forRoundEngine()` to read a job's rounds, `lockForAttempts()`,
  then `AssessmentsService.record()` after every round. See the guide, section 6.

### 6b. Hiring pipeline rules — `pipeline`
Between the rounds: the Stage 2 overall criterion (all technical rounds passed and/or a total % across DSA, SQL and GD),
specific rejection reasons per student, a per-job switch for rejection emails, HR's GD rubric (evaluator form on the GD
results page), and the **Personal interview** page (students who cleared the technical interview, call status and notes,
CSV export). Guide: [docs/HIRING_PIPELINE.md](docs/HIRING_PIPELINE.md).

### 7. Audit log — `audit` (M32)
- Every important action (login, company changes, invitations, job created, JD generated/edited/approved, publish, resume downloaded) is written to `audit_logs`.

---

## Apps and ports

| App | URL | What it is |
|---|---|---|
| HR dashboard | http://localhost:3000 | HR / Company Admin web app |
| Careers site | http://localhost:3300 | Public job pages + apply form |
| API | http://localhost:4000/api/v1/health | NestJS backend |
| AI worker | http://localhost:8000/docs | Python FastAPI, JD generation |
| Mailpit | http://localhost:8025 | Fake inbox for local emails |

HR dashboard pages: `/login`, `/signup`, `/register-company`, `/company`, `/team`, `/jobs`, `/jobs/new`, `/jobs/[id]`, `/publish` (incl. assessment rounds), `/applications`, `/shortlisted`, `/assessments`, `/assessments/[applicationId]`, `/admin`, `/forgot-password`, `/invite/[token]`.

---

## Quick start

```powershell
cp .env.example .env            # then fill DATABASE_URL, GEMINI_API_KEY, LinkedIn keys … (ask the lead)
npx pnpm@9.15.0 install         # pnpm is not on PATH on our laptops, so it runs through npx
docker compose -f infra/docker/docker-compose.yml up -d   # Redis, Mailpit (+ local Postgres if you use it)
npx pnpm@9.15.0 dev             # API :4000, HR dashboard :3000, careers site :3300
cd workers/ai-worker; uv sync; uv run python -m ai_worker # AI worker :8000
```

Every day: `pnpm sync`.  Before every PR: `pnpm check` (+ `uv run pytest` if Python changed).

### Database (Neon)
- The team database is on **Neon** (cloud Postgres 18). Put its URL in `DATABASE_URL` in your `.env`.
  **Never commit `.env` or share the URL in a group chat** — `.env` is git-ignored on purpose.
- New migrations: `cd apps/api; npx prisma migrate deploy` (reads the root `.env`).
- Local Docker Postgres still works for offline work: `DATABASE_URL=postgresql://hire:hire@localhost:5432/hireflow`.

### Public Apply link (Cloudflare tunnel)
LinkedIn posts need a public link to the careers site. One command starts everything **and** the tunnel:

```powershell
powershell -ExecutionPolicy Bypass -File "<project folder>\scripts\start-public.ps1"
```

It starts Docker, a Cloudflare quick tunnel to `:3300`, writes the new `https://….trycloudflare.com` URL into
`CAREERS_SITE_URL` in `.env`, (re)starts the apps, and prints `Apply links now start with: …`.
Needs `cloudflared` (`winget install --id Cloudflare.cloudflared`). Logs: `%LOCALAPPDATA%\hireflow\logs`.
`scripts\register-autostart.ps1` runs it at every Windows login.

> ⚠️ A quick tunnel gets a **new URL every time** (laptop restart, sleep, internet drop). After that, **publish the
> job again** — old posts keep the dead link. The link only works while the laptop that published is on.
> ngrok is no longer used: Windows Defender blocks it on our laptops.

---

## Known limits / next steps
- **Permanent Apply link:** deploy careers site (Vercel) + API (Render/Railway) + Neon + S3/R2 for resumes + a real SMTP (Brevo/Resend). Then `CAREERS_SITE_URL` never changes.
- Resume parsing and ATS scoring are mocks; JD validator has no LLM bias/clarity check yet.
- No Row Level Security yet (scoping is done in code by `tenant_id`).
- Audit log has no read API / UI.
- HR side of the rounds is built (rounds, questions, pass marks, Assessments page). Conducting the rounds for students
  (round engine: invite link, round pages, grading input), proctoring, scheduling, feedback and analytics are not started.
