# ANVEXA — Team Guide (3 interns)

How three people build different modules in parallel, push/pull through GitHub, and have everything work on all three laptops.

Read Part 1 first (the idea), then follow Parts 2–7 step by step.

---

## Part 1 — The idea: why parallel work does not break

Three rules make this safe. Everything else in this guide is just the commands for these rules.

### Rule 1 — Folder ownership
Every folder has exactly one owner (see the table below and `.github/CODEOWNERS`). You edit only your folders. Because nobody edits the same files, git almost never has conflicts.

### Rule 2 — Contracts first
Modules do not call each other's internals. They talk through **shapes defined once** in `packages/contracts` (Zod schemas + event definitions). The Python worker mirrors those shapes in `ai_worker/schemas.py`.

```
 Intern 1 (HR / core)           Intern 3 (candidate side)          Intern 2 (AI)
 ───────────────────            ──────────────────────             ───────────────
 jobs, auth, tenants   ──┐      applications, notifications   ──┐    ai-worker (Python)
 HR dashboard            │      careers-site, candidate-app     │    ats, feedback, prompts
                         ▼                                      ▼
                 ┌────────────────────────────────────────────────────┐
                 │  packages/contracts  (JobForm, ParsedProfile,        │
                 │  AtsScore, events like application.received)         │
                 └────────────────────────────────────────────────────┘
```

Change a contract = a **small PR, merged the same day**, so the other two can pull it before they build on it.

### Rule 3 — Mocks first, real later
The AI worker already runs with **mock endpoints** that return valid data (`/v1/jd/generate`, `/v1/jd/validate`, `/v1/resume/parse`, `/v1/resume/score`). Intern 1 and 3 can build against them on day 1 while Intern 2 replaces the mock bodies with real LLM logic. The URLs and shapes never change, so nothing breaks when the mock becomes real.

### How the three parts meet in v0.1

```
HR fills form ──► jobs (I1) ──► AI worker /jd/generate + /jd/validate (I2) ──► HR approves (I1)
                                                                                    │
                                                          careers page + apply link (I3)
                                                                                    ▼
candidate applies ──► applications (I3) ──event: application.received──► ats (I2)
        ──► AI worker /resume/screen (I2) ──event: ats.scored──► decision (I1)
        ──► shortlisted? invite email / rejected? feedback email (I3 sends, I2 writes content)
```

---

## Part 2 — Who builds what (v0.1, weeks 1–6)

| | Intern 1 — Core & HR | Intern 2 — AI | Intern 3 — Candidate & Comms |
|---|---|---|---|
| **Modules** | M28 auth, M33 tenants, M01 job form, M04 approval, M29 orchestrator, M30 event bus | M31 LLM gateway, M02 JD generator, M03 JD validator, M10 resume parser, M11 ATS scorer, M23 feedback content | M08 apply link, M09 intake, M24 notifications (email), basic M23 delivery |
| **Apps** | `hr-dashboard`, `admin-console` | — (Python worker) | `candidate-app`, `careers-site` |
| **Folders** | `apps/api/src/modules/{auth,tenants,jobs}`, `workers/workflows`, `packages/ui` | `workers/ai-worker`, `prompts`, `apps/api/src/modules/{ats,feedback}` | `apps/api/src/modules/{applications,notifications}`, `packages/email-templates` |
| **First deliverable** | HR can create a job and see the AI-generated JD | Real JD generation + resume scoring behind the same endpoints | Candidate can open a job page and submit an application with a resume |

Later versions (v0.3 rounds, proctoring, etc.) are already assigned by folder in `.github/CODEOWNERS`. Rebalance at the start of v0.3, because Intern 3 gets heavy there.

**Decisions to make as a team in week 1** (the documentation is written for a 5–6 person team over 5–6 months, so v0.1 is the sensible target for three interns):

- **Auth:** the doc picks Keycloak. For v0.1, a simple JWT login in the `auth` module is much faster; keep it behind the module's `index.ts` so you can swap it later.
- **Orchestrator:** the doc picks Temporal. For v0.1 you can start with a plain TypeScript state machine + BullMQ inside the API (the doc allows this for MVP). The docker-compose already has Temporal ready: `docker compose -f infra/docker/docker-compose.yml --profile workflow up -d`.
- **Not in v0.1:** WhatsApp, LiveKit voice screening, rounds, proctoring, multi-channel posting.

---

## Part 3 — Folder structure

```text
hireflow/
├── apps/
│   ├── api/                      # NestJS core API (runs now: /api/v1/health)
│   │   ├── prisma/schema/        # ONE .prisma file per owner → no conflicts
│   │   └── src/modules/
│   │       ├── auth/ tenants/ jobs/ rounds-config/ proctoring/ analytics/ audit/   # I1
│   │       ├── ats/ screening/ evaluator/ feedback/                                # I2
│   │       └── applications/ notifications/ publisher/ scheduler/ round-engine/    # I3
│   ├── hr-dashboard/             # Next.js :3000   (I1)  – you scaffold it (Part 8)
│   ├── candidate-app/            # Next.js :3100   (I3)
│   ├── admin-console/            # Next.js :3200   (I1)
│   └── careers-site/             # Next.js :3300   (I3)
├── workers/
│   ├── ai-worker/                # Python FastAPI :8000 (runs now with mocks) (I2)
│   │   ├── ai_worker/{jd,parsing,scoring,evaluation,feedback,llm_gateway}/
│   │   └── tests/
│   ├── workflows/                # Temporal / state machine (I1)
│   └── activities-ts/            # (I1)
├── packages/
│   ├── contracts/                # SHARED: Zod schemas + events (all review)
│   ├── ui/                       # shared React components (I1, anyone can PR)
│   ├── email-templates/          # (I3)
│   ├── round-sdk/ proctor-sdk/   # later (I3)
│   ├── rounds/{aptitude,coding,website,sql,gaming,communication,group-discussion}/  # later
│   └── config/                   # shared ESLint/TS/Tailwind
├── prompts/                      # versioned LLM prompts (I2)
├── seed/resumes/                 # sample resumes for everyone's testing
├── infra/{docker,terraform,k8s}/ # docker-compose works now; others later
├── docs/                         # this guide + the full project documentation
├── scripts/sync.sh               # `pnpm sync`
└── .github/{CODEOWNERS,pull_request_template.md,workflows/ci.yml}
```

Each folder under `modules/`, `packages/` and `workers/` has a `README.md` stating its owner, the doc module numbers and the release it belongs to.

---

## Part 4 — One-time setup on EVERY laptop

### 4.1 Install

| Tool | Version | Notes |
|---|---|---|
| VS Code | latest | |
| Git | latest | On Windows this also installs **Git Bash** — use it as your terminal |
| Node.js | 22 LTS | |
| pnpm | 9.x | `corepack enable` (the repo pins the version) |
| Python | 3.12 | |
| uv | latest | Python package manager: `pip install uv` |
| Docker Desktop | latest | On Windows enable the **WSL 2 backend** |

### 4.2 Configure Git (once)
```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
git config --global core.autocrlf false      # repo enforces LF line endings itself
git config --global pull.rebase true         # pulls rebase instead of making merge commits
git config --global init.defaultBranch main
```

### 4.3 VS Code
1. Open the **repo root folder** (`hireflow/`), not a sub-folder.
2. VS Code will offer **"Install recommended extensions"** (from `.vscode/extensions.json`) — click Install. This gives everyone the same Prettier, Prisma, Python/Ruff, Docker, GitLens, ErrorLens.
3. Windows only: `Ctrl+Shift+P` → **Terminal: Select Default Profile** → **Git Bash**.
4. Format-on-save and line endings are already set in `.vscode/settings.json`, so everyone's formatting matches.
5. Python: `Ctrl+Shift+P` → **Python: Select Interpreter** → pick `workers/ai-worker/.venv` (appears after `uv sync`).

---

## Part 5 — One person (the lead) creates the shared repo, once

1. On GitHub: **New repository** → `hireflow` → **leave "Add README" unchecked** → Create.
2. Edit `.github/CODEOWNERS`: replace `@intern1 @intern2 @intern3` with the real GitHub usernames.
3. In the unzipped folder:
```bash
cd hireflow
git init -b main
pnpm install                      # creates pnpm-lock.yaml (commit it!)
git add .
git commit -m "chore: initial monorepo skeleton"
git remote add origin https://github.com/<owner>/hireflow.git
git push -u origin main
```
4. **Invite the other two**: repo → Settings → Collaborators → Add people.
5. **Protect `main`**: Settings → Branches → Add rule for `main`:
   - Require a pull request before merging (1 approval)
   - Require status checks to pass → select `typescript` and `python`
   - Block force pushes
   
   > On a private repo with a free GitHub account, branch protection is not available. The GitHub Student Developer Pack gives you Pro for free, or make the repo public. Without protection, simply agree as a team: **nobody pushes straight to `main`**.

---

## Part 6 — Every intern: clone and first run

```bash
git clone https://github.com/<owner>/hireflow.git
cd hireflow
code .
cp .env.example .env              # works as-is for local dev; add your own API keys later (never commit .env)
pnpm install
pnpm infra:up                     # Postgres, Redis, MinIO, Mailpit
cd workers/ai-worker && uv sync && cd ../..
```

Start things (separate terminals):
```bash
pnpm dev                                          # API on :4000 (+ any Next apps that exist)
cd workers/ai-worker && uv run python -m ai_worker   # AI worker on :8000
```

**Check it works:**
- http://localhost:4000/api/v1/health → `{"status":"ok","service":"api"}`
- http://localhost:8000/docs → try `POST /v1/resume/screen`
- `pnpm check` and `cd workers/ai-worker && uv run pytest` both pass

If all three work on all three laptops, the foundation is identical for everyone.

---

## Part 7 — The daily workflow

### 7.1 Start of every day
```bash
git switch main
pnpm sync          # pull latest + pnpm install + uv sync + DB migrations (one command)
```

### 7.2 Working on something
```bash
git switch -c feat/ats-skills-score      # branch name: type/short-description
# ... write code ...
pnpm check                               # lint + types + tests (must pass)
cd workers/ai-worker && uv run pytest    # only if you touched Python
git add .
git commit -m "feat(ats): score skills overlap"
git fetch origin && git rebase origin/main     # bring in teammates' work before you push
git push -u origin feat/ats-skills-score
```
Then on GitHub: **Open pull request** → a teammate reviews → **Squash and merge** → delete branch. Back on your laptop: `git switch main && pnpm sync`.

**Commit message style:** `feat(module): ...`, `fix(module): ...`, `chore: ...`, `docs: ...`.

### 7.3 Habits that prevent 90% of problems
- **Small branches, merged within 1–2 days.** Long-lived branches are what cause painful conflicts.
- **Never commit to `main` directly.** Never force-push `main`.
- **Pull before you start, rebase before you push.**
- **Never commit `.env`** or API keys. Only `.env.example` (placeholders) is committed. A leaked key must be rotated, not just deleted.
- **Tell the team in chat** before you change `docker-compose.yml`, `.env.example`, or a Prisma migration.

### 7.4 Conflict hotspots (the only places two people touch the same file)

| File | Why it conflicts | What to do |
|---|---|---|
| `pnpm-lock.yaml` | Everyone adds packages | Take `main`'s version (`git checkout origin/main -- pnpm-lock.yaml`), then run `pnpm install` |
| `packages/contracts/**` | Shared shapes | Tiny PR, merge same day, announce in chat. If you change a schema also update `ai_worker/schemas.py` |
| `apps/api/prisma/migrations/**` | Two migrations created at once | Delete **your** migration folder, `git pull --rebase`, re-run `prisma migrate dev` |
| `apps/api/src/app.module.ts` | Everyone adds one `imports` line | Keep **both** lines when resolving |
| `.env.example`, `docker-compose.yml` | New variables / services | Keep both sides; announce the change |

To resolve any conflict in VS Code: open the file → use **Accept Current / Accept Incoming / Accept Both** above each conflict block → save → `git add <file>` → `git rebase --continue`.

---

## Part 8 — Scaffold the Next.js apps (each owner, once)

The four web-app folders are empty on purpose (`create-next-app` needs an empty folder). The owner of each app does this on a branch. Example for `candidate-app` (Intern 3):

```bash
git switch -c chore/scaffold-candidate-app
cd apps/candidate-app
rm .gitkeep
pnpm create next-app@15 . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --skip-install
```
Then:
1. In `apps/candidate-app/package.json` set `"name": "candidate-app"`, change the dev script to `"dev": "next dev -p 3100"`, and add `"@hireflow/contracts": "workspace:*"` under dependencies.
2. If the scaffold created its own `pnpm-lock.yaml` or `.git` folder inside the app, delete them.
3. From the repo root: `pnpm install`, then `pnpm check`.
4. Commit, push, open a PR.

| App | Owner | Dev port | Script |
|---|---|---|---|
| hr-dashboard | Intern 1 | 3000 | `next dev -p 3000` |
| candidate-app | Intern 3 | 3100 | `next dev -p 3100` |
| admin-console | Intern 1 | 3200 | `next dev -p 3200` |
| careers-site | Intern 3 | 3300 | `next dev -p 3300` |

Use shared validation in forms: `import { jobFormSchema } from '@hireflow/contracts'` — the front-end and the API then never disagree.

Calling the API from a front-end: `NEXT_PUBLIC_API_URL` in `.env` (already `http://localhost:4000/api/v1`).

---

## Part 9 — How you know everything works together

1. **`pnpm check` before every PR**, plus `uv run pytest` for Python. CI (GitHub Actions) runs the same two checks on every PR, so a broken PR cannot be merged.
2. **Contract tests.** Put a test next to each new schema in `packages/contracts/tests/` (an example for the job form is already there).
3. **Shared sample data.** Everyone tests with the same resumes in `seed/resumes/` — add 5–10 real-looking sample resumes in week 1 (include one scanned PDF and one two-column layout).
4. **Daily 10-minute sync call:** what I merged, what I am changing in a shared file, what I need from you.
5. **Friday integration hour:** all three pull `main`, run `pnpm sync`, and walk one job and one candidate through the whole flow (doc section 20.5): create job → JD generated → approve → apply with a sample resume → score → email appears in Mailpit (http://localhost:8025). Anything broken becomes an issue owned by the folder's owner.
6. **Mock → real handoff.** When Intern 2 replaces a mock with real logic, the endpoint shape does not change, so Intern 1 and 3 need no code changes — they just pull.

---

## Part 10 — First-week plan

| Day | Intern 1 | Intern 2 | Intern 3 |
|---|---|---|---|
| 1 | Lead does Part 5; everyone does Part 4 + 6 | Same | Same |
| 2 | Scaffold `hr-dashboard`; add Prisma (`tenants`, `users`, `jobs` models in own `.prisma` files) | Create first prompts in `prompts/`; build `llm_gateway` (provider + model from `.env`) | Scaffold `candidate-app` + `careers-site`; add Prisma `candidates`, `applications` file |
| 3 | Job form UI using `jobFormSchema`; `POST /jobs` | Real `/v1/jd/generate` returning valid `JdContent` JSON (retry once if invalid) | Job page + apply form (resume upload to MinIO) |
| 4 | Call AI worker for JD; JD review + approve screen | `/v1/jd/validate` (missing salary, biased words, unrealistic experience) | `POST /public/applications`; emit `application.received` |
| 5 | **Friday integration hour** | Same | Same |

---

## Part 11 — Troubleshooting

| Problem | Fix |
|---|---|
| `pnpm: command not found` | `corepack enable` (Node 22), reopen terminal |
| Port already in use (5432, 4000…) | Stop the other program, or `pnpm infra:down` |
| Docker not starting on Windows | Enable virtualization in BIOS; Docker Desktop → Settings → use WSL 2 backend |
| `uv: command not found` | `pip install uv`, reopen terminal |
| "Files differ only in line endings" everywhere | You skipped `core.autocrlf false`; run it, then `git add --renormalize .` |
| API cannot reach AI worker | Is `uv run python -m ai_worker` running? `AI_WORKER_URL` in `.env` should be `http://localhost:8000` |
| Prisma errors after a pull | `pnpm sync` (runs `prisma generate` and `migrate deploy`) |
| I committed a secret | Tell the team immediately, **rotate the key** at the provider, then remove it from the repo |
| Accidentally committed on `main` locally | `git branch feat/my-work` (saves it), `git reset --hard origin/main`, `git switch feat/my-work` |
