# tenants

| | |
|---|---|
| **Owner** | Intern 1 (Core & HR) |
| **Doc modules** | M33 |
| **Release** | v0.1 |

Companies (tenants), per-tenant settings, Row Level Security.

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).

## Implemented (step 1 of the JD flow, see [docs/JD_WORKFLOW.md](../../../../../docs/JD_WORKFLOW.md))
- `GET /api/v1/company-profile` (Company Admin, HR Member): the caller's company profile, or `404 COMPANY_PROFILE_NOT_FOUND`.
- `PUT /api/v1/company-profile` (Company Admin): body `CompanyProfile` (shared `companyProfileSchema`); creates or replaces it.
  `400 INVALID_COMPANY_PROFILE` with `issues[]`.
- Tables (`apps/api/prisma/schema/tenants.prisma`): `tenants` (a company, `status` ACTIVE/SUSPENDED), `company_profiles` (one per tenant).
- `TenantContext` is `RequestTenantContext`: the company and the acting user come ONLY from the session that
  `AuthGuard` verified (ACTIVE membership in an ACTIVE company). Exported with `CompanyProfileService` through `index.ts`.

## Self-service company registration
| Method | Path | Access | Body | Does |
|---|---|---|---|---|
| POST | `/api/v1/companies` | any logged-in user | `CompanyProfile` | Creates the company (slug generated from the name, random suffix if taken), its profile and the caller's `COMPANY_ADMIN` membership in one statement; switches the session to it; returns `Session` |

## Platform Admin: oversight
| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/api/v1/admin/companies` | | All companies with member/job counts |
| GET | `/api/v1/admin/companies/:id` | | Company, members, pending invitations (no jobs or JDs) |
| PATCH | `/api/v1/admin/companies/:id` | `{ status }` (`ACTIVE` or `SUSPENDED`) | Suspended companies keep their data; members get `403 COMPANY_SUSPENDED` |

The tenant created by the old single-company `DefaultTenantContext` (slug `default`) is now a normal company with no
members. Its owner signs up, then the server command `company:assign-admin` (see the auth README) links them as
Company Admin. Its jobs, versions, snapshots and approvals are unchanged.

## Not yet
- No Row Level Security policies (queries are scoped by `tenant_id` in the repositories, plus composite FKs), no per-tenant settings.
