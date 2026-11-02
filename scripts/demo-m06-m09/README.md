# Demo: M06 publisher → M07 channels → M08 apply page → M09 intake

Starts where Intern 1's flow ends (approved JD in the database) and runs the whole M06-M09 flow against the real API.

```bash
pnpm infra:up                         # Postgres, Redis, Mailpit
pnpm install
pnpm --filter api db:deploy           # tables + parser view
pnpm dev                              # API :4000, HR dashboard :3000, careers site :3300
pnpm demo:m06-m09                     # add --keep to leave the application in the database
```

What it does: logs in as the demo HR user (creates it and "Demo Tech Pvt Ltd" the first time) → creates a job →
the AI writes the JD (or, if the AI worker is not available, the ready-made JD from `demo-job.json` is inserted as
version 1) → HR approves (Intern 1's endpoints) → the publisher lists the approved job → previews every channel's
post → publishes → shows a second publish does not post again → student opens the apply link → phone OTP (dev
code) → fake PDF and the EICAR test virus are rejected → real PDF resume submitted → duplicate blocked → the
"thanks for applying" email is found in Mailpit → the parser reads the resume through its read-only view and
cannot delete anything → HR closes the job (late application refused) and reopens it → the student views and
deletes their own data (skipped with `--keep`).

Then: student page = the printed link; HR page = http://localhost:3000/publish (login `demo.hr@hireflow.local` /
`demo-password-123`); emails = http://localhost:8025.

LinkedIn for real: set `LINKEDIN_ACCESS_TOKEN` and `LINKEDIN_API_VERSION` in `.env`, restart the API, then
`LINKEDIN_ORGANIZATION_ID=<your page id> pnpm demo:m06-m09` (the token must belong to an admin of that page).

`create-parser-login.sql` creates the read-only login for the resume parser owner.
