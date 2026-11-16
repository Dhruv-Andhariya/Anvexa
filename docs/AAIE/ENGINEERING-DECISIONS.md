# AAIE — Engineering decisions B1–B3

| | |
|---|---|
| **Purpose** | Decision sheet for the three blockers that gate **Phase 1** (Evidence Bundle + HR Evidence view). |
| **Source of truth** | [`README.md`](README.md) (architecture document). This sheet details B1–B3 only; if they disagree, the README wins and this sheet must be corrected. |
| **Status** | B1 **OPEN**, B2 **OPEN**, B3 **APPROVED** (2026-11-12). |
| **Last updated** | 2026-11-12 (with README version 0.7.0) |

Owners below are given by **module and role**, as listed in each module's README and in `.github/CODEOWNERS`. No
individual has agreed to anything yet. Where a module has no owner entry, that is stated.

### Owner coverage found in the repository

| Module | Owner line in module README | `.github/CODEOWNERS` entry |
|---|---|---|
| `ats` | Intern 2 (AI), built together with Intern 3 | yes (AI owner) |
| `screening` | Intern 2 (AI) | yes (AI owner) |
| `ai-interview` | **none** | **none** |
| `group-discussion` | "M18 AI group discussion" | **none** |
| `dsa` (incl. proctoring) | "DSA assessment developer" | **none** |
| `round-engine` | Intern 3 (Candidate & Comms) | yes (candidate-side owner) |
| `assessments` | **none** | **none** |
| `pipeline` | **none** | **none** |

Confirming who owns `ai-interview`, `group-discussion`, `dsa`, `assessments` and `pipeline` is a prerequisite for B1
and B2.

---

## B1 — Cross-module read approach

**Problem.** AAIE must read evidence from other modules without changing them. Verified state:

- `index.ts` read exports exist for `assessments` (`AssessmentsService`: `resultsFor`, review), `pipeline`
  (`PipelineService`, `PipelineStore`) and `round-engine` (`RoundEngineService.forApplication`, coding-state helpers).
- `ats`, `screening`, `ai-interview`, `group-discussion` and `dsa` export **no read services**.
- The module rule "import only through `index.ts`" covers code imports. The `assessments` store already reads other
  modules' tables through Prisma relations (`apps/api/src/modules/assessments/assessments.store.ts`, lines 84–110).

**Options.**

| Option | What it is | For | Against |
|---|---|---|---|
| **A. Owner-approved public read interfaces** | Each owner adds a small read-only, tenant-scoped method to its `index.ts`, with its own tests and a version field | Ownership respected; owner controls what leaves the module; schema changes stay local | Needs a change by each of the five owners before Phase 1 |
| **B. AAIE read-only Prisma store** | One AAIE store reads owner tables directly (the `assessments` precedent), limited to fields each owner lists in writing | No owner code change; precedent exists | AAIE coupled to owner schemas; owner schema changes can silently break AAIE |
| C. Mixed | A by default; B for a module whose owner prefers it in writing | Unblocks a module whose owner cannot change code soon | Two patterns to maintain |

**Recommended approach.** **A**, with **C** as the fallback per module. Under any option AAIE never writes to,
updates or deletes owner data.

**Required module owners.**

- Agreement from: `ats`, `screening`, `ai-interview`, `group-discussion`, `dsa` (no read exports today).
- Confirmation that existing exports may be used: `assessments`, `pipeline`, `round-engine`.
- Before that: confirm the owners of `ai-interview`, `group-discussion`, `dsa`, `assessments`, `pipeline` (see table).

**Acceptance criteria.**

1. For each of the five modules, the chosen option is recorded in README §2.3 / §13, with the date and the owner role
   that agreed.
2. For Option A, each read is documented: signature, returned fields, the version field (see B3), tenant scoping.
   Each read is read-only and covered by that owner's tests.
3. For Option B, the exact tables and fields AAIE may read are listed and agreed by the owner, and the owner agrees to
   flag schema changes affecting them.
4. No read path writes to an owner table.

**Decision status:** **OPEN.**

---

## B2 — GD evidence expiry / purge status interface

**Problem.** Group-discussion evidence (audio, transcripts, evidence quotes) is deleted by retention. Verified state
(`apps/api/src/modules/group-discussion/gd-results.service.ts`, `gd.worker.ts`):

- There is no stored expiry. `retention()` selects groups whose `endedAt` is older than `GD_RETENTION_DAYS`
  (configurable 1–3650, default 90) at the time it runs.
- The sweep runs about hourly (`RETENTION_EVERY_MS = 60 min`) and handles at most 20 groups per run.
- It deletes audio and `gd_transcripts`, empties `gd_evaluations.evidence` and sets `gd_recordings.deletedAt`; it keeps
  scores, metrics, `feedback`, HR decisions and the GD result's `round_results.notes`.
- The retention configuration is not exported.

AAIE must never show or serve expired GD evidence (D10), including in the window between nominal expiry and the sweep
actually running, and after the retention setting is shortened.

**Options.**

| Option | What it is | For | Against |
|---|---|---|---|
| **A. GD status read** | GD exports `gdEvidenceStatus(tenantId, applicationId) → { endedAt, nominalExpiry, purged }`, computed with its own retention configuration | One authority; handles sweep lag and config changes | Needs a GD owner change |
| B. AAIE computes expiry | AAIE reads `endedAt` and duplicates the `GD_RETENTION_DAYS` rule | No GD change | Duplicated rule drifts if GD changes its policy; breaks ownership |
| C. Purge flag only | AAIE trusts only "evidence deleted" (`evidence = []`, `deletedAt`) | Simple | Serves evidence after nominal expiry until the sweep runs (up to hours or more) |

**Recommended approach.** **A.** AAIE treats GD evidence as expired when `now ≥ nominalExpiry` **or** `purged`, and
checks this live before serving any summary that cites GD evidence (README §5.2). B and C are not recommended.

**Required module owners.** `group-discussion` (role: "M18 AI group discussion" per its README; no CODEOWNERS entry —
owner to be confirmed).

**Acceptance criteria.**

1. Interface agreed and recorded in README §5.2 / §13.
2. It reports expiry as soon as `now ≥ nominalExpiry`, **before** the sweep runs.
3. It reports `purged = true` after the sweep ran for that group.
4. A shortened `GD_RETENTION_DAYS` is reflected on the next call.
5. Groups that have not ended report no expiry.
6. Tenant-scoped (another company's application returns not found).
7. Owner tests cover: not ended, ended and live, expired but not swept, purged, retention setting changed.

**Decision status:** **OPEN.** Phase 1 may ship without GD evidence if B2 is not resolved.

---

## B3 — Evidence source versioning scheme

**Problem.** Many referenced records can change after creation, so a reference without a version can silently point
to different content:

- `round_results`: re-recorded via `upsertResult`, regraded by `changePassRule`, overridden.
- `ats_evaluations`: re-evaluation.
- `screening_results`: HR "retry summary".
- `ai_interview_reports`: HR `retryReport`.
- `gd_evaluations`: re-evaluation, HR rubric, retention empties `evidence`.
- Stable: `screening_turns` and `ai_interview_turns` (unique `(sessionId, seq)`); round questions are frozen once a
  job's rounds lock.

**Options.**

| Option | What it is | For | Against |
|---|---|---|---|
| A. `updatedAt` only | Version = the row's `updatedAt` | Cheap | Wrong for partial citations (one GD evidence item, one coding entry); depends on every change bumping `updatedAt` |
| B. Content hash only | Version = SHA-256 of canonical JSON of the cited element | Exact; works for partial citations | Must hash the same canonical form every time |
| **C. Per kind** | `updatedAt` for whole-row sources that reliably bump it; content hash for partial elements and rows without a reliable `updatedAt` | Exact where it matters, cheap elsewhere | Needs a per-kind table and owner confirmation |

**Recommended approach.** **C**, as proposed in README §4.1:

| Reference kind | Proposed version |
|---|---|
| `ats` | `updatedAt` (owner to confirm it changes on every re-evaluation) |
| `screening` (turn) | content hash |
| `screening-summary` | `updatedAt` (owner to confirm) |
| `round` (canonical, incl. coding) | `updatedAt` (owner to confirm it changes on re-record, regrade and override) |
| `coding` (supplementary) | content hash of the `codingState` entry |
| `interview` | report `generatedAt` / `updatedAt` (owner to confirm) |
| `gd` | content hash of the cited element, plus B2 expiry status |
| `hr-notes` | `updatedAt` of the `round_results` row |

Canonical JSON for hashing: keys sorted, no insignificant whitespace, UTF-8, SHA-256, hex. A stored reference is
`{ ref, sourceVersion }` with `sourceVersion` prefixed `u:` (timestamp) or `h:` (hash).

**Required module owners.** AAIE (proposer, owner to be assigned) defines the scheme; confirmation of `updatedAt`
behaviour from the owners of `ats`, `screening`, `assessments`, `ai-interview`, `group-discussion`.

**Acceptance criteria.**

1. Every reference kind in README §4.1 has an agreed version source, recorded in the README.
2. Where an owner cannot confirm that `updatedAt` changes on every content change, a content hash is used.
3. Stale detection outcomes `CURRENT` / `CHANGED` / `MISSING` / `EXPIRED` (README §4.3) are specified with test cases,
   including: result re-recorded, pass rule changed, override added, interview report regenerated, GD evidence
   purged, application erased.
4. The bundle `inputHash` includes every `sourceVersion`.

**Decision status:** **APPROVED** by the product owner on 2026-11-12: immutable, linked evidence versioning (as in
`DSA-SQL/README.md` §10.3). Every submission and execution result stays traceable to its original assessment result
and later AAIE evaluations; re-evaluations create new versions; existing records are never overwritten. (Source owners'
confirmation of `updatedAt` behaviour is still collected during implementation; where it cannot be confirmed, a
content hash is used.)

---

## DSA + SQL scope notes (from the Phase 0 audit, 2026-11-12)

For the DSA + SQL pipeline (`DSA-SQL/README.md`), B1–B3 apply with these concrete interfaces. **All still OPEN.**

- **B1 (reads and hooks) — owners:** `round-engine` (Intern 3 (Candidate & Comms)), `dsa` (DSA assessment developer),
  `sql`, `assessments` (owner to be confirmed), `rounds-config` (exported service exists).
  - Read: finished coding attempts with `codingState` (today only `RoundEngineService.forApplication` exists).
  - Read: questions with HR's marks and tests (`RoundsConfigService` exists; test categories need D25 storage).
  - Hook: append-only submission capture in `DsaService.submit()` (and `run()` if Runs count) — must never block or
    fail the candidate.
  - Hook: progression hold before `claimProgress()` and one method that applies AAIE's outcome (DSA-SQL §10.0).
- **B3 (versioning):** `round_results.updatedAt` exists (`@updatedAt`); `codingState` entries need a content hash;
  stored submissions (D24) are immutable, so their id is their version.
- New blockers B8–B10 are tracked in the README §13 (B8 decided by D31).
- **Full detail for DSA + SQL:** owners and interfaces H1–H6, R1–R4, A1, U1 in `DSA-SQL/README.md` §10.2; the
  versioning chain (question → submission → execution result → original result → AAIE evaluation → AAIE outcome →
  effective outcome) in §10.3. B1 remains **OPEN** until the owners agree; B3 **APPROVED** 2026-11-12.

## B1 agreement record — DSA + SQL Phase 1 interfaces (2026-11-12)

The product owner reported on 2026-11-12 that the developers agreed to the B1 Phase 1 integration requirements below.
No developer names, agreement dates or written evidence were provided, so each row is recorded as **verbally
confirmed** with the formal evidence pending. Nothing here is invented: "not named" / "not stated" / "pending" mean the
information has not been supplied yet.

| Module | Interface | Requirement | Owner of record (repository) | Agreeing developer | Agreement date | Status | Evidence link |
|---|---|---|---|---|---|---|---|
| `dsa` | **H1** | Capture every Run and Submit (non-blocking, idempotent: D35–D37) | "DSA assessment developer" (module README); no CODEOWNERS entry | not named | not stated | **Verbally confirmed** — reported by the product owner on 2026-11-12 | pending |
| `dsa` | **R1** | Provide test cases with categories (D25) | "DSA assessment developer"; no CODEOWNERS entry | not named | not stated | **Verbally confirmed** — reported 2026-11-12; *category storage still undecided (readiness row 6)* | pending |
| `sql` | **R1** | Provide SQL datasets with categories (D25) | "SQL rounds" (module README); no CODEOWNERS entry | not named | not stated | **Verbally confirmed** — reported 2026-11-12; *category storage still undecided (row 6)* | pending |
| `round-engine` | **R2** | Read access to finished coding attempts | Intern 3 (Candidate & Comms) (README); CODEOWNERS `GrisaPujara` | not named | not stated | **Verbally confirmed** — reported 2026-11-12 | pending |
| `rounds-config` | **R3** | Existing HR weights, pass rules and round order (`RoundsConfigService`, already exported) | Intern 1 (Core & HR) (README); CODEOWNERS `naina-chauhan` | not named | not stated | **Verbally confirmed** — reported 2026-11-12 | pending |
| `assessments` | **R4** | Access to original assessment results (`AssessmentsService.resultsFor`, already exported) | **not listed** in README or CODEOWNERS | not named | not stated | **Verbally confirmed** — reported 2026-11-12; *module owner still unidentified* | pending |

**What this agreement does not cover**

- It does **not** authorise implementation (an explicit go-ahead is still required).
- Phase 6 interfaces **H2–H6** and **U1** (progression hold, outcome application, recovery exclusion, board / review
  list, Stage 2 / PI reads, candidate messages) remain **future integration requirements**, not Phase 1 tasks.
- The per-click idempotency key on the candidate page (D35, readiness row 10) needs the candidate-app owner's
  agreement, which is not part of this record.
- The general (non-DSA/SQL) AAIE read interfaces (ats, screening, ai-interview, group-discussion) remain **OPEN**.

**To complete the record:** for each row add the agreeing developer's name or role, the date of agreement and a link
(PR review, issue or written note). For `dsa`, `sql` and `assessments`, also confirm who owns the module.

**B1 status:** DSA + SQL Phase 1 subset **verbally confirmed — formal evidence pending**; overall B1 **OPEN**.

## D38 impact on B1 (2026-11-12)

D38 (APPROVED) adds a Python + FastAPI AAIE service for DSA + SQL. This affects B1:

- The **evidence data path is undecided (T2)**: NestJS sends the evidence to the Python service through its owner-
  approved reads (Option A of B1 preserved), or the Python service reads Postgres directly (comparable to Option B, but
  outside Prisma). The choice must respect module ownership and tenant isolation and be recorded here.
- The **writer of AAIE records is undecided (T3)** and depends on the schema review.
- B1 stays **OPEN**.

## Recording a decision

When a decision is agreed: change its status here and in README §12–§13 to "Agreed", add the date, the chosen option
and the agreeing owner role, and add a row to the README's version history. Rejected options stay listed with the
reason.
