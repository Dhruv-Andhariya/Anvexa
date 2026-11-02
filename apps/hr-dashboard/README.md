# hr-dashboard — Next.js :3000 (owner: Intern 1)

```bash
pnpm --filter hr-dashboard dev     # http://localhost:3000  (needs the API on :4000 and the AI worker on :8000)
pnpm --filter hr-dashboard test
```

| Page | Step | What it does |
|---|---|---|
| `/login` | — | Login for returning users (session cookie set by the API) |
| `/signup` | — | New company HR, step 1: create an account |
| `/register-company` | — | New company HR, step 2: company profile → company created, user becomes Company Admin |
| `/invite/[token]` | — | Accept an invitation: create an account, or join with an existing account's password |
| `/admin`, `/admin/companies/[id]` | — | Platform Admin: list registered companies, view members, suspend/activate |
| `/team` | — | Company Admin: invite HR members, change roles, disable access |
| `/company` | 1 | Company profile form (Company Admin edits; HR Members see it read-only) |
| `/jobs` | — | Job list with status (Draft / Awaiting approval / Approved) |
| `/jobs/new` | 2 | Job form; the saved company profile is loaded and shown automatically. Saves the job, then opens its review page |
| `/jobs/[id]` | 3 + 4 | Generates the JD (job form + company profile), then: edit (saved as a new version), regenerate, version history + restore, edit requirements, verify company details, approve |

The full walkthrough is in [docs/JD_WORKFLOW.md](../../docs/JD_WORKFLOW.md).

- Form validation uses the shared schemas from `@hireflow/contracts` (`jobFormSchema`, `companyProfileSchema`).
- The browser calls only the HireFlow API (`NEXT_PUBLIC_API_URL`, default `http://localhost:4000/api/v1`).
  No AI credentials exist in this app.
- Auth: `src/components/session.tsx` loads `/auth/me`, sends logged-out users to `/login` and hides pages the role
  cannot use. This is only for display: the API enforces every permission and picks the company from the session.
- Everything is saved: every AI draft and every HR edit is a separate JD version.
