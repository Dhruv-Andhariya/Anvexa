# round-engine

| | |
|---|---|
| **Owner** | Intern 3 (Candidate & Comms) |
| **Doc modules** | M13 (online test rounds), M21 (browser proctoring events) |
| **Release** | v0.3 |

Runs the **online test rounds** HR configured on the Publish page (rounds-config), e.g. *Aptitude & English
Literacy*, after the AI voice screening: invitation email -> secure link -> timed, webcam-monitored test on the careers
site (`/assessment/[token]`) -> server-side grading through the assessments module -> next round's invitation, or an
outcome email. Full guide: [`docs/APTITUDE_ASSESSMENT_ROUND.md`](../../../../../docs/APTITUDE_ASSESSMENT_ROUND.md).

A round runs online (`roundKind`) in one of two ways, both with a score-based pass rule:

- **TEST**: only MCQ / true-false questions. The candidate takes it on the careers site (`/assessment/[token]`).
- **CODING (DSA round)**: every question is a **DSA bank problem** (a CODING question with the topic `dsa:<id>`, picked in
  the rounds editor; `isDsaRound` in contracts). The candidate takes it on the candidate app (`/dsa/[token]`), served by
  the `dsa` module. Same invitation, clock, result and next-step machinery; the engine only stores the candidate's
  progress (`round_attempts.coding_state`) and turns it into marks. Switch off with `DSA_ROUNDS=off`. Guide:
  [`docs/DSA_ASSESSMENT_ROUND.md`](../../../../../docs/DSA_ASSESSMENT_ROUND.md).

Other rounds (descriptive questions, coding questions without a bank problem, interviews) are run by HR; the engine
stops before them and emails the candidate that HR will contact them.

## Files
| File | What it does |
|---|---|
| `online-test.ts` | Pure rules: which rounds run online and how (`roundKind`), public questions (no answers), answer checks, next step, event severity |
| `coding-round.ts` | Pure rules of DSA rounds: the state kept per attempt, marks (best submission per problem), answers handed to assessments |
| `round-engine.service.ts` | Candidate flow (view / start / autosave / submit / events), grading + next step (once), HR view, revoke, resend |
| `round-engine.worker.ts` | Background loop: invite after AI screening, send invitations + outcome emails, time-outs, interrupted next steps |
| `round-engine.store.ts` | All database access (abstract class; tests use an in-memory store) |
| `link.ts` | Link token (32 random bytes; only its SHA-256 is stored) and the link base URLs (assessment page, DSA page) |
| `emails.ts` | Invitation (multiple-choice or coding wording), rejection and "cleared" emails (no score, no pass mark, no proctoring details) |
| `public-assessment.controller.ts` / `hr-round-engine.controller.ts` | Routes |

Tables: `prisma/schema/round_engine.prisma` (`round_invites`, `round_attempts` incl. `coding_state`, `round_proctor_events`,
`round_outcome_emails`, `dsa_proctor_sessions`). Results: `round_results` through `AssessmentsService.record()` (pass / fail decided only in
`assessments/grading.ts`).

| Method | Path | Who |
|---|---|---|
| GET | `/public/assessment/session` | candidate (header `x-assessment-token`) |
| POST | `/public/assessment/start` | candidate - `{ consent: true }` |
| PUT | `/public/assessment/answers` | candidate - `{ revision, answers }` (autosave) |
| POST | `/public/assessment/submit` | candidate - `{ revision, answers }` |
| POST | `/public/assessment/events` | candidate - `{ events: [{ type, occurredAt, detail }] }` |
| GET | `/round-engine/applications/:applicationId` | HR `jobs.read` |
| POST | `/round-engine/applications/:applicationId/rounds/:roundId/revoke` | HR `jobs.write` |
| POST | `/round-engine/applications/:applicationId/rounds/:roundId/resend` | HR `jobs.write` (FAILED invitation only) |

In-process API used by the `dsa` module (through `index.ts` only): `RoundEngineService.openCodingRound(token)`,
`startCodingAttempt`, `saveCodingProgress`, `finishCodingAttempt`. Finishing records the result and queues the next
step exactly like a submitted test; a candidate who never comes back is timed out by the worker with the saved progress.

Feature flag: `FEATURE_ROUND_ENGINE=off`. Rate limit: `assessment` in `PUBLIC_RATE_LIMITS`. Audit: `assessment.invite_queued`,
`.invite_sent`, `.started`, `.submitted`, `.timed_out`, `.progressed`, `.outcome_email_sent`, `.invite_revoked`,
`.invite_resent` (plus `assessment.result_recorded` from the assessments module).

## Not yet
- No event bus (M30): progression is done here, idempotently, instead of a central orchestrator.
- An HR override made AFTER the outcome email does not send a new email or invitation.
- Sections, negative marking and per-job camera settings do not exist in the round configuration (rounds-config);
  questions are shown in HR's order, unanswered = 0 marks, camera rule is the server setting `ASSESSMENT_REQUIRE_CAMERA`.
- Rate limiter in memory (one API instance).

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).
