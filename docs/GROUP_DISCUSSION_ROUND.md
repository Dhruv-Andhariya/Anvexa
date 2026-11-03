# M18 AI Group Discussion round

Students who pass the round before a group discussion (GD) are grouped automatically, get a personal link, join a
live video room, and discuss a topic run by an AI moderator. HR is in the room as a labelled tile, can speak to the group or to one
student, and makes the final selection after an AI evaluation of every student.

Built like the aptitude round ([APTITUDE_ASSESSMENT_ROUND.md](APTITUDE_ASSESSMENT_ROUND.md)): one API, one database,
HR's normal login, the round / topics / pass rule from the Publish page. **Everything is free**: LiveKit Cloud's free
plan (video), students' own browsers record their audio (no paid recorder), Whisper and the moderator's voice (Piper)
run on the server's own CPU, the evaluation uses the Gemini key HireFlow already has (free tier).

| Part | Where |
|---|---|
| API (scheduling, live timeline, emails, evaluation pipeline, results) | [`apps/api/src/modules/group-discussion`](../apps/api/src/modules/group-discussion/README.md) |
| Student lobby + GD room | `apps/careers-site/src/app/gd/[token]` |
| HR: schedule groups, live dashboard, results | `apps/hr-dashboard/src/app/group-discussion` (`/`, `/live/[batchId]`, `/results/[batchId]`) |
| AI moderator bot, Whisper, LLM rubric (Python) | [`workers/gd-agent`](../workers/gd-agent/README.md) |
| Shapes shared by all of them | `packages/contracts/src/schemas/group-discussion.ts` |

## 1. The flow

```
HR: Publish page -> job rounds e.g. 1 "Aptitude" (online test) -> 2 "Group Discussion" (type Group Discussion,
    questions = topics, pass rule = interviewer score e.g. 6 of 10) -> complete -> publish
student passes round 1 -> round engine: next round is a GD -> no email (hand-off)
   -> GD worker: every earlier round passed (HR override counts) / AI screening done if the GD is first -> POOL
HR: Group Discussion page -> "Schedule": name, first start, group size 6-10, phase lengths, HR questions on/off
   -> the whole pool split into groups that run one after another (own time slot, LiveKit room, topic)
emails: invitation with a personal link (+ HR gets the live-page link) -> reminder 15 min before (same link)
start time: room opens (lobby: camera preview, mic meter, recording consent - Join only when all three are OK)
start + 5 min (joining window): room LOCKS, missing students ABSENT (kept; HR can admit or move them)
   -> AI moderator joins: INTRO (rules) -> THINKING (topic spoken + banner) -> DISCUSSION (silent; a gentle prompt
      after 20 s of silence) -> SUMMARY (calls each student, 1 min each) -> HR QUESTIONS (optional) -> CLOSE
   -> every screen follows the server's timeline (LiveKit room metadata); HR speaking pauses the discussion timer
after: Whisper per recording -> one timeline, HR's lines labelled "HR asked:" -> speaking metrics -> LLM rubric per
   student (strict JSON, Pydantic + one retry) -> HR results: ranked, scores, evidence quotes, AI recommendation
HR: override any decision (logged) -> "Confirm selection" -> result recorded in Assessments + emails
   (selected: next round / not selected: polite update)
retention: audio + transcripts deleted GD_RETENTION_DAYS (90) after the GD
```

## 2. What students see (`/gd/[token]`)

| Screen | Content |
|---|---|
| Lobby | Company, job, round; start time, room closing time, group size, phase lengths; how it works; **camera preview, microphone level meter**; consent checkbox (audio recorded, transcribed, AI-assisted evaluation, live HR observation, retention, deletion right); countdown; Join (disabled until camera works, the mic picked up their voice, and consent is ticked) |
| Room | Topic banner (from thinking time on), phase tracker, countdown timer ("Paused, HR speaking" while HR talks), video grid with the **AI moderator** as its own tile, **active speaker highlighted**, "Camera off" tags, "With HR" tile for a student in a private talk, HR tile only while HR speaks (else "HR observing"), bottom bar: mute, camera, raise hand, leave |
| Private talk | A small room with HR; the group carries on; back to the group automatically |
| After | "Thank you, the result comes by email" |

A student who drops (network, reload, closed tab) opens the same link and gets "Rejoin" - no new consent, same place.
A camera that goes off shows a warning and is flagged for HR; nobody is removed.

## 3. HR

**Group Discussion page:** waiting students, the scheduling form with a live preview of groups and times, every
event with its groups (topic can be changed until a group starts; an event can be cancelled until its first group
starts), links to each group's live page and results.

**Live page (`/group-discussion/live/[batchId]`):** HR joins as a visible, labelled tile with camera and mic **off**; the Camera / Mute buttons turn them on at any time (unmuting does not pause the timer). Same grid as the students (everyone fits on one screen, no scrolling), plus:

| Control | What happens |
|---|---|
| Speak to group | HR's mic turns on; during the discussion the timer pauses ("Paused, HR speaking") and resumes when HR mutes; HR's microphone is recorded for context |
| Talk privately (on a tile) | The student and HR move to a temporary private room; the student's tile shows "With HR"; the bot and the others carry on |
| Send back | The student returns to the group |
| HR questions phase | HR is unmuted and visible automatically; the bot only announces the phase |
| Admit / Move (absent students) | Admit = may still join with their link; Move = to a later group of the round (a new link is emailed) |

Side panel: attendance, live talk-time bars, flags (camera off now / how often, raised hands), HR activity log.
Live transcript: not available live (transcripts are made after the GD).

**Results page (`/group-discussion/results/[batchId]`):** students ranked by overall score, AI recommendation, per
criterion scores, speaking metrics, evidence quotes, feedback; per student "Follow AI / Selected / Not selected"
(override, logged with HR's name and the time); private talks with **Include in evaluation** (re-evaluates the group);
"Confirm selection" (once) records every result in Assessments (overall score as the interviewer score, HR's decision
as an override where it differs) and emails every student.

Every HR action (speaking, pauses, private talks, admits, moves, overrides, confirmation) is in `gd_hr_activity` with
the HR user and the time, and in the audit log.

## 4. Evaluation

| Criterion | 1-10 |
|---|---|
| content | relevance and factual accuracy |
| communication | clarity and fluency (**accent and minor grammar are not penalised**) |
| initiative | starting / moving the discussion forward |
| listening | building on others' points |
| balance | fair talk time, not dominating or interrupting |
| summary | their summary round |
| hr_response | only if HR asked them something, else null |

The LLM gets the student's own lines, the whole discussion (HR as "HR asked:", never scored) and the measured
metrics, and must return exactly `{ student_id, scores, overall, recommendation, evidence[], feedback }` - validated
with Pydantic (one retry), and again with zod in the API. Private talks are left out unless HR includes them.

Metrics (no AI): talk time and share, words per minute, filler words, turns (pieces < 1.5 s apart = one turn),
interruptions (starting while another student had talked 0.5 s and went on), summary seconds in their own slot,
answered HR (first to speak within 30 s after HR).

### Whole-session recording

After the evaluation the GD worker (`POST /gd/mix`, PyAV, free) mixes every recording of the group (each student's
and HR's microphone) on one timeline - 0 = the room locked, the same clock as the transcripts - into one audio file,
`GD_STORAGE_DIR/<company>/<group>/session.webm` (Opus, about 15 MB an hour). A student's private talk with HR is
muted in it (not part of the group's discussion). Audio only: there is no video recording (LiveKit Cloud's own
recording would use up the free plan). HR plays or downloads it on the group's **Results** page and under the GD
round on **Assessments -> Assessment Rounds**. If the worker was down, the results page shows why and has
"Build the recording". The file is deleted with the rest of the audio after `GD_RETENTION_DAYS`.

## 5. Privacy (DPDP principles)

- **Consent** before joining (`consent_version`, `consent_at` stored); the invitation already explains the recording.
- **Purpose limitation:** audio is used only for this GD's evaluation and HR's review (the session recording);
  never shown to other students.
- **Access control:** audio files are only reachable through the API (HR of the same company) and the local worker;
  links are 32 random bytes, only their hash is stored (plus a sealed copy for the reminder).
- **Deletion:** audio, transcripts and evidence quotes are deleted `GD_RETENTION_DAYS` (default 90) after the GD; a
  student's "delete my data" removes their GD rows (cascade) and the hourly clean-up removes orphaned audio folders.

Not a legal compliance statement - review with your legal team before real use.

## 6. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | - | LiveKit Cloud free project (cloud.livekit.io) |
| `FEATURE_GROUP_DISCUSSION` | on | off = no GD routes / pool; the old "HR will contact you" email |
| `GD_PROCESSING` / `GD_POLL_MS` / `GD_LIVE_POLL_MS` | on / 10000 / 1000 | background loops |
| `GD_URL` | empty | student page with `{token}`; empty = `${CAREERS_SITE_URL}/gd/{token}` |
| `GD_ALLOW_LOCAL_LINKS` | off | local tests only: also email localhost links |
| `GD_STORAGE_DIR` | `~/.hireflow/gd-recordings` | audio folder (API writes, worker reads) |
| `GD_RETENTION_DAYS` | 90 | deletion of audio + transcripts |
| `GD_WORKER_URL` / `GD_WORKER_TIMEOUT_MS` / `GD_WORKER_SECRET` | `http://localhost:8010` / 15 min / empty | the Python worker |
| `GD_WHISPER_MODEL` / `GD_WHISPER_LANGUAGE` | base / en | faster-whisper on the CPU |
| `GD_LLM_MODEL` | `LLM_MODEL` | evaluation model (with `GEMINI_API_KEY`, `LLM_FALLBACK_MODELS`) |
| `GD_PIPER_VOICE` | en_US-lessac-medium | the moderator's voice |

## 7. Run it locally

```bash
pnpm install
pnpm --filter api db:deploy       # 20261102130000_group_discussion + 20261102140000_group_discussion_live (additive)
cd workers/gd-agent && uv sync && uv run python -m gd_agent download   # Whisper model + Piper voice, once
# everything (API, HR, careers, tunnel, AI worker, GD worker, AI moderator):
powershell -ExecutionPolicy Bypass -File scripts/start-public.ps1
```

Or by hand: `pnpm dev`, then in `workers/gd-agent`: `uv run python -m gd_agent api` (port 8010) and
`uv run python -m gd_agent moderator dev`. Logs: `%LOCALAPPDATA%\hireflow\logs\gd-worker.log`, `gd-moderator.log`.

Camera and microphone need https (or localhost): students use the Cloudflare tunnel link from their emails.

**Manual test:** Publish page: job with *Aptitude* -> *Group Discussion* (2-3 topics) -> complete. Let 3+ students pass
the aptitude round (or record passes on the Assessments page) -> they appear under Group Discussion -> Waiting.
Schedule an event ~20 minutes ahead with a short discussion (5 min) -> invitation emails (Mailpit / Gmail) -> open
the links in different browsers / phones -> at the start time Join -> HR opens "Join live" -> after the joining window
the moderator speaks; try Speak to group (timer pauses), Talk privately / Send back, raise hand, camera off -> at the
end the results page fills in a few minutes -> override one decision -> Confirm selection -> result emails.

**Automated:**
`pnpm --filter api exec vitest run tests/group-discussion` (planning, timeline, metrics, links, emails, hand-off) and
with `TEST_DATABASE_URL=postgresql://hire:hire@localhost:5432/gd_check_test` also the real-database tests, including
one whole GD from invitation to retention (`gd-flow.db.test.ts`). Python: `cd workers/gd-agent && uv run pytest`.

## 8. Limits (free setup)

- LiveKit Cloud free plan: ~5,000 participant-minutes/month (about 10-12 groups of 10), 100 people at once. The
  room, timer and moderator work across the internet; only the API / workers run on this PC.
- Whisper `base` on a laptop CPU: a few minutes per group; `small` is more accurate and slower.
- Gemini free tier rate limits: a group of 10 is 10 calls; a failed evaluation can be run again from the results page.
- A selected student whose next round is an online test is not invited automatically yet (the email says HR will
  contact them).
