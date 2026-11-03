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

Exception: when the next round is a **Group Discussion** and `FEATURE_GROUP_DISCUSSION` is on, `nextStep()` returns
`GROUP_DISCUSSION` and no email is sent; the group-discussion module (M18) picks the student up.

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

## Round modules (GD, DSA, SQL, AI interview)
A round that is not a plain online test can be run by a **round module** with its own candidate page. Which module
runs which round type is `ROUND_MODULE_OF` in `packages/contracts` (`GROUP_DISCUSSION` -> GD, `CODING` -> DSA,
`SQL` -> SQL, `AI_INTERVIEW` -> AI interview). The round engine sends a student who passed the round before to that
module only when the module is **connected**; until then HR runs the round (the "next round is run by HR" email), so
HR can already add these rounds to a job. **DSA** is the exception: a DSA round (every question a DSA problem) is run
by this engine itself (`roundKind` CODING, see above), so the DSA module is connected whenever `DSA_ROUNDS` is on; a
coding round without DSA problems is run by HR. To plug a new module in (see `rounds-config/round-modules.ts`):

```ts
// my-module.module.ts: imports RoundEngineModule (and RoundsConfigModule)
onModuleInit() { this.roundModules.connect('SQL'); }

// who is waiting: passed every earlier round (HR override first), no result in this round yet
const waiting = await roundEngine.waitingForModule('SQL', { tenantId });   // [{ tenantId, applicationId, jobId, roundId }]

// after the student finished on the module's own page:
await roundEngine.recordModuleResult(tenantId, 'SQL', {
  applicationId, roundId,
  marks: 34,                                                     // what the round's pass rule needs
  answers: [{ questionId, answer: 'SELECT ...', marksAwarded: 8, feedback: 'correct rows' }],
  notes: 'Checked on the sample database',
});
```

The result and every answer show on the HR **Assessments** page (code in a monospace block), and the student moves on
exactly as after an online test (next invitation or email, queued once). A module can only record rounds of its own
type (`409 ROUND_NOT_FOR_MODULE`) and of the given company (`404`). The GD module connects itself when
`FEATURE_GROUP_DISCUSSION` is on, DSA when `DSA_ROUNDS` is on. Not connected yet: SQL, AI interview.

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
