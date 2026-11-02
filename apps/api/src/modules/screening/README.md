# screening

| | |
|---|---|
| **Owner** | Intern 2 (AI) |
| **Doc modules** | M12 |
| **Release** | v0.2 (browser voice, Gemini; LiveKit / phone mode later) |

AI voice screening round. A shortlisted candidate opens the link from the shortlist email (careers site
`/screening/[token]`), gives consent, and answers six short spoken questions. Every answer is transcribed and saved at
once; HR reads the transcript and structured notes on the Shortlisted page. Information only: no score, no decision.
Full guide: [`docs/SCREENING_ROUND.md`](../../../../../docs/SCREENING_ROUND.md).

## Built so far
| File | What it does |
|---|---|
| `flow.ts` | The fixed question flow (6 steps, follow-up limits, time/turn caps, closing). Pure, no I/O. |
| `screening.service.ts` | Candidate side: token -> invite -> application, start/consent, answers (idempotent), speech, end, summary. |
| `hr-screening.service.ts` | HR side: list per job, detail, review status, retry summary; display status (EXPIRED / INTERRUPTED). |
| `screening.store.ts` | All database access (Prisma) behind an abstract class (tests use an in-memory store). |
| `screening-worker.client.ts` | AI worker client: `/v1/screening/turn`, `/speak`, `/extract`. |
| `speech-cache.ts` | In-memory LRU of spoken questions (main questions are the same for every candidate). |
| `link.ts` | The link token hash (same as the ats module, which creates the invite when it sends the shortlist email). |

Tables: `prisma/schema/screening.prisma` (`screening_sessions`, `screening_turns`, `screening_results`), reusing
`screening_invites` (ats) and `consents` (applications).

| Method | Path | Who |
|---|---|---|
| GET | `/public/screening/session` | candidate (header `x-screening-token`) |
| POST | `/public/screening/start` | candidate - body `{ consent: true }` (first time), resumes later |
| POST | `/public/screening/answer` | candidate - multipart `audio`, `seq`, `clientTurnId`, `durationMs` |
| GET | `/public/screening/speech?seq=` | candidate - the question as `audio/wav` |
| POST | `/public/screening/end` | candidate - stop early (resumable while the link is valid) |
| GET | `/screening/jobs/:jobId` | HR `jobs.read` |
| GET | `/screening/applications/:applicationId` | HR `jobs.read` |
| PUT | `/screening/applications/:applicationId/review` | HR `jobs.write` - `{ reviewStatus }` |
| POST | `/screening/applications/:applicationId/summary` | HR `jobs.write` - create the summary again |

Feature flag: `FEATURE_SCREENING=off` turns every route off. Public routes are rate-limited per IP (`screening`,
`screening-answer` in `PUBLIC_RATE_LIMITS`). Audit: `screening.started`, `screening.completed`, `screening.ended_early`,
`screening.reviewed`.

## Not yet
- Events (`screening.completed` etc.) are only audited; there is no event bus yet (M30).
- HR cannot reissue a link: a link is valid 7 days from the shortlist email (ats module). Resend = later.
- Raw audio is never stored (by design for v0.2); only transcripts.
- Rate limits and the speech cache are in memory (one API instance). Redis when the API scales out.

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).
