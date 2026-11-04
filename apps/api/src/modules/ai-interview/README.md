# ai-interview

| | |
|---|---|
| **Doc** | [`docs/AI_TECHNICAL_INTERVIEW.md`](../../../../../docs/AI_TECHNICAL_INTERVIEW.md) |
| **Release** | v0.1 |

Runs the job rounds of type `AI_INTERVIEW` (round editor: "AI Technical Interview") as a **round module**: the round
engine hands over every student who passed the rounds before (whichever rounds HR chose), this module invites them,
runs the spoken interview on the careers site (`/interview/[token]`), writes the report, and records **HR's decision**
back through `RoundEngineService.recordModuleResult()` (next invitation or outcome email, once).

## Files
| File | What it does |
|---|---|
| `flow.ts` | Pure rules: config snapshot, server clock (pauses, grace), next question (limits, fallbacks), fallback plan, greeting / closing |
| `ai-interview.service.ts` | Candidate flow: link -> session, start / resume / pause / events / repeat / end, answers, spoken questions, plan, report |
| `ai-interview-hr.service.ts` | HR view (incl. integrity: warnings, incidents, termination), decision (once; reason when overruling the score or deciding on a terminated interview), hand-over to the round engine |
| `protection.ts` | Pure protection rules: which incident qualifies, grouping / dedup, the ONE warning counter, termination text, the page's protection state |
| `protection.service.ts` | `InterviewProtectionService`: the single source of truth for warnings (public report + acknowledge; HR round settings) |
| `ai-interview.worker.ts` | Background loop: invite waiting students, send invitation emails, time-out sweep, reports, unrecorded decisions |
| `ai-interview.store.ts` | All database access (abstract class; tests use an in-memory store) |
| `ai-interview-worker.client.ts` | AI worker client (`/v1/interview/plan`, `/turn`, `/speak`, `/report`) |
| `link.ts` / `emails.ts` | Link token (SHA-256 stored) and base URL; the invitation email |
| `public-interview.controller.ts` / `hr-interview.controller.ts` | Routes |

Tables: `prisma/schema/ai_interview.prisma` (`ai_interview_invites`, `_sessions`, `_turns`, `_events`, `_reports`,
`_violations`, `_protection_settings`), migrations `20261103170000_ai_technical_interview` and
`20261104090000_ai_interview_protection` (both additive).

| Method | Path | Who |
|---|---|---|
| GET | `/public/interview/session` | candidate (header `x-interview-token`) |
| POST | `/public/interview/start` · `/resume` · `/pause` · `/events` · `/repeat` · `/end` | candidate |
| POST | `/public/interview/answer` (multipart: audio, seq, clientTurnId, durationMs) | candidate |
| GET | `/public/interview/speech?seq=` (audio/wav) | candidate |
| POST | `/public/interview/violation` (`{ incidentId, type, detail? }`) · `/violation/ack` (`{ warningNumber }`) | candidate |
| GET | `/ai-interview/applications/:applicationId` | HR `jobs.read` |
| POST | `/ai-interview/applications/:applicationId/rounds/:roundId/decision` · `/report` | HR `jobs.write` |
| GET · PUT | `/ai-interview/jobs/:jobId/rounds/:roundId/protection` | HR `jobs.read` · `jobs.write` |

Feature flags `FEATURE_AI_INTERVIEW`, `FEATURE_AI_INTERVIEW_PROTECTION`; loop `AI_INTERVIEW_PROCESSING`; rate limits
`interview`, `interview-answer`. Audit: `ai_interview.protection_warning`, `.terminated`, `.protection_settings_updated`.
Tests: `apps/api/tests/ai-interview/*`.
