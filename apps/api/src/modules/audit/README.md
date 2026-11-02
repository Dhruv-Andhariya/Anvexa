# audit

| | |
|---|---|
| **Owner** | Intern 1 (Core & HR) |
| **Doc modules** | M32 |
| **Release** | v1.0 |

Audit log of every AI decision and human override.

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).

## Implemented (minimal)
- Table `audit_logs` (`apps/api/prisma/schema/audit.prisma`): tenant, actor, action, subject, metadata. Append-only.
- `AuditService.record()` (global module). Written for: login, logout, failed login, company created/suspended/activated,
  invitations, membership changes, company profile saves, job created, JD generated/edited, job approved.
- Not yet: read API/UI, AI decision audit (input hash, scores), retention.
