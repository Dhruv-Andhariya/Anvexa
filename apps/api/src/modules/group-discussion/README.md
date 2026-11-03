# group-discussion

| | |
|---|---|
| **Owner** | M18 AI group discussion |
| **Doc modules** | M18 (AI group discussion) |
| **Release** | v1.2 |

Runs the **Group Discussion** rounds HR configured on the Publish page (round type `GROUP_DISCUSSION`; its questions
are the topics). Students who pass every earlier round wait in the round's **pool**; HR schedules **events** that split
the pool into **groups** (batches), each with its own time slot, LiveKit room and topic; each group runs live with an
AI moderator; afterwards every student is transcribed and evaluated, and HR confirms the selection.
Full guide: [`docs/GROUP_DISCUSSION_ROUND.md`](../../../../../docs/GROUP_DISCUSSION_ROUND.md).

## Files
| File | What it does |
|---|---|
| `planning.ts` | Pure: GD rounds, topics, topic per group, room names (group sizes + slots are in `@hireflow/contracts`) |
| `timeline.ts` | Pure: the phases, step / pause / resume of the moderator's timeline |
| `metrics.ts` | Pure: one transcript timeline, private talks in / out, speaking metrics, texts for the evaluator |
| `link.ts` | Student link token (hash stored) and link URLs |
| `emails.ts` | Invitation, reminder, HR live link, result emails |
| `gd.service.ts` | Scheduling: rounds, overview, create / cancel events, change a group's topic |
| `gd-live.service.ts` | Student link (lobby, join, reconnect, recording chunks, events, private talk), HR live controls, the timeline loop that opens / locks rooms and runs the phases, live state pushed as LiveKit room metadata |
| `gd-mail.service.ts` | The GD email log (`gd_emails`): queue + send with retries |
| `gd-results.service.ts` | Transcription + evaluation pipeline, results, overrides, private talks in / out, confirmation, retention |
| `gd.worker.ts` | Background loops: live (~1 s) and slow (pools, emails, evaluation, hourly retention) |
| `gd.store.ts` | Database access of the scheduling part (abstract; in-memory fake in tests) |
| `livekit.ts` | LiveKit gateway: tokens, rooms, room metadata, HR visibility, moderator dispatch |
| `storage.ts` | Audio chunks on disk (`GD_STORAGE_DIR`) |
| `gd-worker.client.ts` | HTTP client of `workers/gd-agent` (Whisper, rubric) |
| `hr-gd.controller.ts` / `public-gd.controller.ts` | Routes |

Tables: `prisma/schema/group_discussion.prisma`; migrations `20261102130000_group_discussion`,
`20261102140000_group_discussion_live` (both additive).

| Method | Path | Who |
|---|---|---|
| GET | `/group-discussion/rounds`, `/rounds/:roundId` | HR `jobs.read` |
| POST | `/group-discussion/rounds/:roundId/events`, `/events/:eventId/cancel` | HR `jobs.write` |
| PUT | `/group-discussion/batches/:batchId/topic` | HR `jobs.write` |
| GET | `/group-discussion/batches/:batchId/live` | HR `jobs.read` (HR's LiveKit connection, visible tile) |
| POST | `/group-discussion/batches/:batchId/speak`, `/private-talks`, `/participants/:id/admit`, `/recordings` | HR `jobs.write` |
| POST | `/group-discussion/private-talks/:talkId/end`, `/participants/:id/reschedule`, `/recordings/:id/chunks` | HR `jobs.write` |
| GET | `/group-discussion/batches/:batchId/results` | HR `jobs.read` |
| PUT | `/group-discussion/batches/:batchId/students/:participantId/decision`, `/private-talks/:talkId/include` | HR `jobs.write` |
| POST | `/group-discussion/batches/:batchId/reprocess`, `/confirm` | HR `jobs.write` |
| GET | `/public/gd/session`, `/state`, `/private` | student (header `x-gd-token`) |
| POST | `/public/gd/join`, `/events`, `/recordings`, `/recordings/:id/chunks` | student (header `x-gd-token`) |

Hand-off from the round engine: `nextStep()` in `round-engine/online-test.ts` returns `GROUP_DISCUSSION` (no "HR will
contact you" email) when the next round is a GD round and this module is on.

Feature flag `FEATURE_GROUP_DISCUSSION=off`. Rate limits `gd`, `gd-audio`. Audit: `gd.pool_joined`,
`gd.event_scheduled`, `gd.event_cancelled`, `gd.topic_changed`, `gd.email_sent`, `gd.joined`, `gd.started`, `gd.ended`,
`gd.rescheduled`, `gd.evaluated`, `gd.decision_overridden`, `gd.selection_confirmed`, `gd.recordings_deleted`
(+ `gd_hr_activity` for every HR action).

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).
