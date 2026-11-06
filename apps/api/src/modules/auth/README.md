# auth

| | |
|---|---|
| **Owner** | Intern 1 (Core & HR) |
| **Doc modules** | M28 |
| **Release** | v0.1 |

Login and RBAC for staff. Candidates and interviewers come later.

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).

## Roles
| Role | Level | Can |
|---|---|---|
| Platform Admin (`users.is_platform_admin`) | platform | `/admin/companies`: list, view, suspend/activate. Cannot create companies or invite company staff. **No** access to company jobs/JDs |
| `COMPANY_ADMIN` | company | everything HR can + edit the company profile + manage the team (`/company/*`). Whoever registers a company becomes its Company Admin |
| `HR_MEMBER` | company | read the company profile, create/edit jobs, generate/edit/approve JDs |

The permission matrix is [`permissions.ts`](permissions.ts). Platform Admin is granted only by the CLI, never by the API:

```bash
PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_NAME="Your Name" PLATFORM_ADMIN_PASSWORD='…' pnpm --filter api admin:create
```

## How people get in
- New company: `POST /auth/signup` (account, no company, never Platform Admin) → `POST /companies` with the company
  profile (tenants module) → the caller becomes `COMPANY_ADMIN` of the new company.
- Returning user: `POST /auth/login` (+ `POST /auth/login/verify` with the emailed code when 2FA is on).
- Joining an existing company: invitation from that company's Company Admin (`/company/invitations`).
- Legacy company without members (slug `default`): `COMPANY_SLUG=default USER_EMAIL=… pnpm --filter api company:assign-admin`.

## How a request is authorised
1. `AuthGuard` is global (`APP_GUARD`). A route without `@Public` / `@Authenticated` / `@PlatformAdminOnly` /
   `@RequirePermission` is rejected (fail closed).
2. Writes must send `X-Requested-With: hireflow` (CSRF: forces a CORS preflight; the cookie is also `SameSite=Lax`).
3. The `hireflow_session` cookie (httpOnly, random 256-bit token) is looked up by its SHA-256 hash in `sessions`.
4. The session's company is re-checked on every request: ACTIVE membership + ACTIVE company + role permission.
   Disabling a member, changing a role or suspending a company applies from the next request.
5. Services read the company from `TenantContext` (tenants module), never from the URL, body or headers.

## Endpoints
| Method | Path | Access | Does |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | public, rate-limited (10/IP/hour) | `{ name, email, password }` → session cookie + `Session` (no company). `409 EMAIL_TAKEN`. With email verification on → `{ codeRequired, challenge, emailHint, expiresAt }`, a code emailed, **no account yet** |
| POST | `/api/v1/auth/signup/verify` | public, rate-limited | `{ challenge, code }` → creates the account, session cookie + `Session`. 5 tries per code, 10-minute expiry, single use |
| POST | `/api/v1/auth/login` | public, rate-limited | `{ email, password }` → session cookie + `Session`; with 2FA on → `{ codeRequired, challenge, emailHint, expiresAt }` and a 6-digit code emailed (no cookie yet). Unknown email → `401 ACCOUNT_NOT_FOUND` (the login page sends the person to `/signup`); wrong password → `401 INVALID_CREDENTIALS` |
| POST | `/api/v1/auth/login/verify` | public, rate-limited | `{ challenge, code }` → session cookie + `Session`. 5 tries per code, 10-minute expiry, single use |
| GET | `/api/v1/auth/providers` | public | `{ google }`: which "Continue with ..." buttons to show |
| GET | `/api/v1/auth/google/start?next=&mode=login\|signup` | public (browser navigation) | redirect to Google (state + PKCE + mode in a 10-minute cookie). No / other mode = `login` |
| GET | `/api/v1/auth/google/callback` | public (browser navigation) | logs in / links / (sign-up page only) creates the account, sets the session cookie, redirects to the dashboard (`/login?oauth_error=` on failure; `/signup?oauth_error=no_account` when a login finds no account) |
| POST | `/api/v1/auth/logout` | public | deletes the session, clears the cookie |
| GET | `/api/v1/auth/me` | logged in | `Session`: user, current company + role, all companies |
| POST | `/api/v1/auth/company` | logged in | `{ companyId }`: switch company (active membership required) |
| GET | `/api/v1/auth/invitations/:token` | public, rate-limited | invitation preview |
| POST | `/api/v1/auth/invitations/accept` | public, rate-limited | `{ token, name?, password }`: new account, or an existing account **with its own password** |
| GET | `/api/v1/company/members` | Company Admin | members + pending invitations |
| POST | `/api/v1/company/invitations` | Company Admin | `{ email, role }` → one-time `inviteUrl` (shown once) |
| DELETE | `/api/v1/company/invitations/:id` | Company Admin | revoke |
| PATCH | `/api/v1/company/members/:userId` | Company Admin | `{ role?, status? }`; the last active Company Admin cannot be removed |

- Tables (`apps/api/prisma/schema/auth.prisma`): `users`, `sessions`, `memberships`, `invitations`.
- Passwords: Node `scrypt` (N=2^15), no native dependency. Session and invitation tokens are stored only as hashes.
- Team invitation links are returned to the inviter (no email delivery yet, M24 notifications).
- Login/accept rate limits are in memory per API process (move to Redis when running several replicas).
- Login 2FA (`LOGIN_2FA=email`, default on in production): after the right password a 6-digit code is emailed
  (`login_challenges`; only hashes stored, the code hash is bound to the browser's challenge token). Outside
  production the code is also printed to the API console, for test accounts with made-up emails.
- Sign-up email verification (`SIGNUP_VERIFY_EMAIL=email`, default on in production): the form's details wait in
  `signup_challenges` (password already scrypt-hashed) and the user row is created only with the right emailed code.
- Continue with Google (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, see `google-oauth.ts`): known Google id
  (`users.google_sub`) logs in; else the account with the same Google-verified email is linked; else - only when the
  button was on the SIGN-UP page (`mode=signup`) - a new account is created (random password - "Forgot password?" sets
  one). From the login page nothing is created: the browser goes to `/signup?oauth_error=no_account` (audit
  `auth.login_failed`, reason `no_account`). No emailed code: Google verified the email and runs its own
  2-step verification. An email already linked to a different Google account is refused, never re-linked.
- Session cookie: `HttpOnly`, `SameSite=Lax`, and `Secure` for every HTTPS request and always in production
  (`COOKIE_SECURE=false` only affects plain-HTTP local dev).

## Tests
`tests/multi-company.e2e.test.ts` runs two companies end to end against a real database: isolation, roles, suspension,
invitations, CSRF, rate limiting. It needs a migrated test database, and is skipped in `pnpm test` without one:

```bash
DATABASE_URL=postgresql://hire:hire@localhost:5433/hireflow_test pnpm --filter api db:deploy
TEST_DATABASE_URL=postgresql://hire:hire@localhost:5433/hireflow_test pnpm --filter api test:db
```

## Not yet
- Authenticator-app 2FA, Microsoft SSO (doc M28), email delivery of invitations,
  Redis-backed rate limits.
