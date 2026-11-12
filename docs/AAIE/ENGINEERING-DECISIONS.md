# AAIE — Engineering decisions B1–B3

| | |
|---|---|
| **Purpose** | Decision sheet for the three blockers that gate **Phase 1** (Evidence Bundle + HR Evidence view). |
| **Source of truth** | [`README.md`](README.md) (architecture document). This sheet details B1–B3 only; if they disagree, the README wins and this sheet must be corrected. |
| **Status of all three** | **OPEN** — no owner agreement has been recorded. |
| **Last updated** | 2026-11-11 (with README version 0.2.1) |

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

**Decision status:** **OPEN.**

---

## Recording a decision

When a decision is agreed: change its status here and in README §12–§13 to "Agreed", add the date, the chosen option
and the agreeing owner role, and add a row to the README's version history. Rejected options stay listed with the
reason.
