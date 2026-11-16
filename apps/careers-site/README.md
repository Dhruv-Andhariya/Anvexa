# careers-site — Next.js :3300 (owner: Intern 3)

Public job pages and the apply form (doc M08). Every post's "Apply here" link opens a page here.

```bash
pnpm --filter careers-site dev      # http://localhost:3300  (needs the API on :4000)
pnpm --filter careers-site test
```

| Page | What it does |
|---|---|
| `/[company]` | live jobs of one company |
| `/[company]/jobs/[job]` | full approved JD (server-rendered fresh on each request) + apply form |
| `/[company]/my-data` | student verifies phone → sees / deletes their data (DPDP) |
| `/screening/[token]` | AI voice screening (personal link from the email) |
| `/assessment/[token]` | online test rounds: aptitude & English, technical MCQ |
| `/dsa/[token]` | DSA / SQL coding rounds (editor, run / submit, camera proctoring). Moved here from the former `apps/candidate-app` (:3001); calls `/api/v1/dsa/*` through `next.config.ts`. Files: `src/app/dsa/[token]/`, `src/lib/dsa-api.ts`, `src/lib/dsa-camera.ts`, `src/components/dsa-ui.tsx`; face / object models from `scripts/prepare-face-model.mjs` (runs before dev / build) |
| `/gd/[token]` | group discussion |
| `/interview/[token]` | AI technical interview |

| File | Change it when… |
|---|---|
| `src/content.ts` | any wording on the site (labels, consent text, messages) |
| `src/app/[company]/jobs/[job]/page.tsx` | job page layout |
| `src/app/[company]/jobs/[job]/apply-form.tsx` | apply form UI (OTP, upload progress) |
| `src/lib/apply-form.ts` | form rules (uses the shared `applyFormSchema`, same as the API) |
| `src/components/phone-verify.tsx` | phone + OTP widget (+ optional Turnstile CAPTCHA) used by both forms |

- Fast on slow internet: the JD is plain server HTML; only the form is client JS (~126 kB first load in total).
- Env: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api/v1`), `CAREERS_SITE_URL` (canonical URLs),
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (CAPTCHA; empty = off), `TRUSTED_CLIENT_IP_HEADER` (see below).
- `src/middleware.ts` + `src/lib/client-ip.ts`: before `/api/v1/public/*` and `/api/v1/dsa/*` are proxied to the API, `X-Forwarded-For` is
  replaced by the edge's header (`TRUSTED_CLIENT_IP_HEADER`, e.g. `cf-connecting-ip` behind a Cloudflare tunnel) or
  removed, so students cannot fake their IP for the API's per-IP limits. Deploy this site so it is reachable ONLY
  through that edge; without the variable all students count as one IP (local dev).
