# AI Technical Interview Round (voice)

A student who passed the round before it gets a personal link and has a spoken technical interview (10-30 minutes)
with an AI interviewer. The interviewer asks about **their own resume**, the **job's skills** and **practical
scenarios**, and follows up on what they actually say. HR reads an evidence-based report and **makes the decision**:
the AI's score and recommendation are advice only.

Code: [`apps/api/src/modules/ai-interview`](../apps/api/src/modules/ai-interview/README.md) (API),
`workers/ai-worker/ai_worker/interview` (AI), `apps/careers-site/src/app/interview/[token]` (candidate page),
`apps/hr-dashboard/src/components/ai-interview-panel.tsx` (HR). Contracts: `packages/contracts/src/schemas/ai-interview.ts`.

## 1. Where it sits in the hiring flow

The rounds of a job are **chosen and ordered by HR** on the Publish page (Aptitude, DSA, SQL, Gaming, Group
Discussion, ...). The AI interview is the round type **"AI Technical Interview"** and can be placed anywhere:

```
... any rounds HR chose, in HR's order ...
   -> student passes the round before (or finishes AI voice screening, when the interview is the first round)
   -> round engine: waitingForModule('AI_INTERVIEW')       (the same hand-over GD and DSA use)
   -> ai-interview worker: one invitation per student per round, email with a personal link (7 days)
   -> careers site /interview/<token>: consent -> camera + microphone check -> interview
   -> interview ends (AI concluded / time up / candidate ended / abandoned) -> report in the background
   -> HR: Assessments -> student -> round card -> "AI technical interview" panel -> Advance / Reject
   -> round engine: round_results (AI score as the interviewer score, HR override when HR decided otherwise)
      -> next round's invitation, or the "cleared" / rejection email - exactly once
```

Nothing is hard-wired to Group Discussion: the hand-over query only asks "did the student pass every earlier round
of this job?". With `FEATURE_AI_INTERVIEW=off` the module is not connected and HR runs the round (the existing
"next round is run by HR" email).

### HR setup (rounds editor, no new screen)

| Field of the round | Used as |
|---|---|
| Time limit | Interview length, **10-30 minutes** (default 20). Checked by the shared schema at every save. |
| Pass rule | Must be **Interviewer score N of M**. The AI's 0-100 score is scaled to M (72 -> 7 of 10). |
| Questions (Interview kind) | **HR's own questions**: always asked (as a planned topic). Their expected answer is used only by the report, never shown. |
| Description | Shown in the invitation email as "Instructions from the hiring team". |

The round's settings are **copied onto the session** at the first visit (`ai_interview_sessions.config`), so later
edits never change an interview that was already opened. Starting an interview locks the job's rounds.

## 2. The conversation

| Step | Who decides | How |
|---|---|---|
| Greeting | API (fixed text) | Name, role, length, "Are you ready to begin?" |
| Plan | AI worker `POST /v1/interview/plan` | Topics from the parsed resume (~40%), job skills (~25%), scenarios (~25%), HR questions (all). A RESUME topic must name an item that is in the resume, else it is dropped. AI down -> plan by rule from the resume / job / HR questions. |
| Each answer | AI worker `POST /v1/interview/turn` | 1. transcribe the **audio alone** (+ a spelling list of technical terms); 2. read the answer (STRONG, INCOMPLETE, VAGUE, INCORRECT, OFF_TOPIC, DONT_KNOW, UNCLEAR_AUDIO...) and propose FOLLOW_UP / CLARIFY / NEXT_TOPIC / CONCLUDE + the question (text only) |
| Limits | API (`flow.ts`) | max 2 follow-ups per topic, never a repeated question, "don't know" is never pressed, no conclusion before the minimum time (70% of the length, at least 10 min), one last question in the final 90 s, closing at the end (+60 s grace for an answer in progress), 40 answers max |
| Fallback | API | Any missing / invalid / late AI proposal -> the next planned topic's question. The interview never stalls on bad AI output. |

The interviewer never gives answers, hints or scores, does not praise every answer, and only asks about the job.

## 3. Voice architecture

```
Browser (careers site)                      API (NestJS)                          AI worker (FastAPI)       Gemini
camera + mic: getUserMedia (preview only)
live preview text: Web Speech API (browser)
MediaRecorder (webm/opus | mp4) ---------> POST /public/interview/answer ------> /v1/interview/turn
                                           token -> invite -> session            1. transcribe (audio only) -> LLM_MODEL
                                           seq + clientTurnId (idempotent)       2. normalise terms (rules)
                                           server clock, limits, saves turn <-   3. next question (text)    -> LLM_MODEL
<audio> plays WAV                <-------- GET /public/interview/speech -------> /v1/interview/speak       -> SCREENING_TTS_MODEL
                                           (cache; next question prepared early)
                                           on completion (background) ---------> /v1/interview/report      -> LLM_MODEL
```

- **Turn-based HTTP, not a WebSocket.** Every answer is one request that is saved once (`clientTurnId`), so a dropped
  connection, a refresh or a second tab always continue at the same question; it works through the careers-site proxy
  and Cloudflare tunnels unchanged. The whole request is kept under the proxy's 30 s (worker budget 24 s).
- **End of an answer**: the page detects it (after >= 2.5 s of speech, 4.5 s of silence ends it with a visible
  countdown; any sound cancels), or the candidate presses "Done answering"; 4 minutes max.
- **Transcripts**: `raw_transcript` = word for word from the audio alone (the source of truth, also what the candidate
  sees); `normalized_transcript` = the same words with technical terms spelled consistently by rules ("post gres" ->
  "PostgreSQL"; never an AI rewrite); `transcript_quality` + `unclear_terms` from the transcriber. An unclear answer is
  never scored in the report. Silence is never saved (checked in the browser and by the transcriber).
- **Live transcript**: the browser's own speech recognition, shown as a preview only and never saved (Chrome / Edge;
  other browsers show none). The saved transcript is the server's.
- **Providers are replaceable**: LLM through `llm_gateway.LLMProvider`, TTS through `speech.SpeechProvider`. True
  server-side streaming STT (partial results over a socket) needs a streaming STT provider account (e.g. Google
  Speech-to-Text, Deepgram, AssemblyAI) - not set up in this project; it would replace step 1 of the turn.
- Measured locally (India -> Gemini, free tier): spoken answer -> next question 7-25 s; a slow decision falls back to
  the plan instead of timing out. A paid Gemini key is needed for real candidates (the free tier quota is small).

## 4. Camera, microphone and integrity

- Camera **and** microphone are required to start (`POST /start` needs `{ consent, camera, microphone }`); the page
  shows a live preview, a microphone level meter that must hear the candidate once, the connection, and whether a live
  transcript is available.
- During the interview: a camera / microphone that stops (track ended) or a lost connection **pauses** the interview;
  the server clock stops (up to 10 minutes of pauses in total), and the same question is asked again after resuming
  with both devices on. Closing / reloading the page also pauses it; reopening shows "Welcome back".
- Stored for HR as facts only (`ai_interview_events`): camera / mic lost + restored, connection lost + restored, page
  hidden / visible / closed, question repeated, paused / resumed. Never scored. Warnings come only from the
  interview protection below.
- **No video or audio is recorded or uploaded**; no face recognition, gaze or emotion analysis, no screen recording.
  The only use of the picture is an optional on-device face COUNT (below).

### 4a. Interview protection (one warning counter)

Shown to the candidate before they agree (welcome page), enforced by the server (`InterviewProtectionService`).

```
Warning 0 -> 1st qualifying incident: Warning 1 -> 2nd: Final Warning 2 -> 3rd: interview TERMINATED
             (one counter for every type; maxWarnings = 2 by default, 1-5 per round)
```

| Incident (page reports it) | Browser signal | Default handling |
|---|---|---|
| `TAB_SWITCH` - other tab, minimised, screen locked | `visibilitychange` -> hidden | warning |
| `WINDOW_BLUR` - another window / app focused > 2 s while the page stays visible | `blur` (+ grace), `focus` | warning |
| `FULLSCREEN_EXIT` - Escape / left fullscreen (when required and the browser supports it) | `fullscreenchange` | warning |
| `CAMERA_LOST` / `MIC_LOST` - track ended, unplugged, permission revoked | track `ended`, `readyState` | pause + recovery, **no warning** (HR may choose WARN: one warning per incident) |
| `MULTIPLE_FACES` - 2+ faces counted for 5 s (one episode, ends after 3 s with <= 1 face) | MediaPipe face detector in the browser, ~1 frame/s, only the number used | **warning** (HR may choose RECORD only or OFF) |
| reload / close, lost connection, permission prompt | `pagehide` / `beforeunload`, `offline` | never a warning (pause + "Welcome back" / reconnect) |

- **One incident, one entry.** The page groups the events of one act (Alt+Tab out of fullscreen fires blur,
  fullscreenchange and hidden; coming back fires visible + focus) into one incident with one random `incidentId`. The
  server is the backstop: the same `incidentId` again is answered from the stored row (idempotent, safe with keepalive
  and retries); a qualifying incident within 3 s (server time) of the last counted one is GROUPED into it (measured
  from the counted one, never extended - rapid switching keeps counting); a device still lost is the same incident
  until the interview resumes with it back.
- **Atomic.** Each report runs in one transaction that locks the interview row (`SELECT ... FOR UPDATE`), reads the
  counter and earlier incidents, stores the incident and the new counter (and the termination) together. A partial
  unique index (`session_id, warning_number` for counted incidents) and `CHECK (warning_count >= 0)` back it up.
- **Only while running.** Tab / window / fullscreen count only while the interview is IN_PROGRESS (not on the setup,
  pause, or end screens: a paused candidate may need browser settings to re-allow the camera). Devices are accepted
  while paused too. Not started / ended -> IGNORED (nothing stored).
- **Persistent.** Count, incidents and acknowledgements are in the database; the page reads them with the session (a
  reload, a new tab or a reconnect shows the same count and re-shows an unacknowledged warning). The page never sends a
  count; extra fields are ignored. Undelivered reports are re-sent with the same id when the connection is back.
- **Termination** (`status TERMINATED`, `endedReason MAX_WARNINGS_EXCEEDED`, `integrity_status
  INTEGRITY_VIOLATION_REVIEW`): the pending question moves on (an answer in flight is refused, `409
  INTERVIEW_TERMINATED`), every later call is refused, the page stops the voice, microphone and camera at once and
  leaves fullscreen. Saved answers and transcripts stay; the report is written from them. Audit
  `ai_interview.terminated` (once), `ai_interview.protection_warning` per warning.
- **HR decides.** Termination is never a rejection: the Assessments board shows "Integrity review: interview
  terminated", the HR panel shows the rules the interview ran with, every incident (time, type, result, warning #,
  acknowledged, resolved) and the termination reason. HR must write a reason to decide; the decision goes through the
  round engine as usual and marks the review REVIEWED.
- **HR setup**: rounds editor -> AI Technical Interview round -> "Interview protection" (warnings 1-5, tab / window
  monitoring, fullscreen, camera / microphone policy). Saved per round (`ai_interview_protection_settings`), read-only
  once the rounds are locked; copied onto each interview at its first visit (`ai_interview_sessions.protection`), so
  the rules a candidate was shown are the rules enforced. Interviews opened before this feature have no snapshot and
  are not monitored. `FEATURE_AI_INTERVIEW_PROTECTION=off` stops monitoring new interviews.
- **Face counting** (`multipleFacesPolicy`): runs on the candidate's device with MediaPipe's short-range face model
  (`public/models/blaze_face_short_range.tflite`, committed) and WASM runtime (copied from `node_modules` into
  `public/mediapipe/` before `dev` / `build`, git-ignored; ~9.5 MB, served by this site, downloaded only once the
  interview starts). Only the count leaves the browser, as an incident (`detail` e.g. "2 faces"). Short-range model:
  faces further than ~2 m may be missed; photos / posters can be counted. If the detector cannot load, the interview
  goes on without it ("Face check unavailable").
- **What it cannot know**: browsers only tell a page that it was hidden or lost focus - never which site or app was
  opened, nor a second device. Without fullscreen support (iPhone Safari) fullscreen is not monitored. Stored: type,
  server time, a short detail (e.g. `visibilitychange`) - no content.

## 5. The report and HR's decision

- Made after the interview from the saved transcript only (`POST /v1/interview/report`): 7 dimensions (technical
  knowledge, own projects, practical implementation, problem solving, scenario reasoning, depth, clarity of
  explanations) 0-10 **with the answer numbers as evidence** (no evidence = not assessed), an evaluation per answer
  with a quote that must literally be in the answer, strengths, improvement areas, skills shown / not verified.
- **Computed in code, not chosen by the model**: overall 0-100 (weighted mean; clarity counts half) and the label:
  >= 80 Strongly recommended, >= 65 Recommended, >= 45 Needs human review, else Not recommended. Fewer than 3 answers,
  >= 30% unclear transcripts, or no score -> **uncertain** and "Needs human review". Accent, grammar and speed are not
  judged.
- HR panel (student review page, inside the AI interview round card): status, interview time, report, transcript
  (raw + normalised, quality, how each answer was read), events, and **Advance / Reject**. Deciding against the score's
  pass mark needs a reason (stored as the audited override). The decision is stored once and handed to the round
  engine; if that fails, the worker loop retries it. The Assessments board shows the progress ("AI: Recommended, HR to
  decide").

## 6. Security and privacy

- The link is a bearer credential for one application's one round: only its SHA-256 is stored, new token per send
  attempt, 7 days from sending, sent in the `x-interview-token` header (never in API URLs). Page headers:
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `noindex`, `Permissions-Policy: camera=(self), microphone=(self)`.
- No ids, emails, resume data, scores or plan in the candidate's API responses. Nothing a request carries can name
  another application, job or company; HR routes take the company from the session (another company's ids are 404),
  `jobs.read` / `jobs.write`, CSRF header on writes. Per-IP rate limits `interview` / `interview-answer`.
- Audit: `ai_interview.invite_queued`, `.invite_sent`, `.started`, `.completed`, `.ended_by_candidate`, `.timed_out`,
  `.report_ready`, `.decided` (+ `assessment.result_recorded`, `.result_overridden`, `.progressed` from the round engine).
- Everything is deleted with the application (`ON DELETE CASCADE`, incl. the candidate's "delete my data"). Raw audio is
  sent to Gemini for transcription and not stored. Consent is recorded (`consents.purpose = ai_technical_interview`).
  Decide a retention period before real use; not a legal compliance statement.

## 7. Run it locally

```bash
pnpm install
cd apps/api && npx prisma migrate deploy      # applies 20261103170000_ai_technical_interview + 20261104090000_ai_interview_protection (additive)
pnpm dev                                      # API :4000, HR :3000, careers :3300
cd workers/ai-worker && uv run python -m ai_worker
```
Settings: the `AI_INTERVIEW_*` / `INTERVIEW_*` block in `.env.example` (defaults are fine). Invitations wait until the
interview link is public (`scripts/start-public.ps1`) - or set `ROUND_ALLOW_LOCAL_LINKS=on` for Mailpit testing.
Camera and microphone need a secure page: `localhost` or https.

## 8. Tests

| Where | Command | Covers |
|---|---|---|
| Contracts | `pnpm --filter @hireflow/contracts test` | round editor rules for AI interview rounds (via API tests) |
| API | `pnpm --filter api test` (`tests/ai-interview/*`, `tests/round-engine/*`) | link valid / invalid / expired / other company, consent + devices, config snapshot, plan once (and by rule), adaptive follow-ups and limits, no repeats, silence, idempotent re-sends, AI busy, server clock + grace + final question, pause / resume / pause allowance, events, repeats, ending early, report, HR view isolation, decision once, reason when overruling, HR questions to the Assessments page, recovery of an unrecorded decision, invitation once with a personal link, local links held, time-out sweep, HR decision as override in the round engine |
| AI worker | `uv run pytest tests/test_interview.py` | transcription sees no context, normalisation only re-spells terms, resume-grounded plan (invented items dropped, HR questions kept), follow-up / conclude / don't-know rules, repeats dropped, new topics grounded, silence, decision failure keeps the transcript, report evidence / quotes / unclear answers / computed score and labels |
| Careers site | `pnpm --filter careers-site test` | end-of-answer detection, error mapping, device errors, live transcript absent; protection monitor (`tests/interview-protection.test.ts`): one incident per tab switch, blur grace, minimise, reload not counted, fullscreen exit / restore / Alt+Tab grouping, inactive outside the interview, warning wording |
| API protection | `pnpm --filter api test` (`tests/ai-interview/protection.test.ts`) | warning 1 / final 2 / terminated on the 3rd, one counter for all types, idempotent incident ids, grouping window, simultaneous reports, flood cap, devices RECOVER vs WARN, ignored while paused / not started / legacy, refresh + acknowledgement persistence, page cannot set the count, no answers after termination (also one in flight), report from saved answers, other candidate / company isolation, HR integrity view + decision with reason, per-round settings + snapshot |

Verified by hand (3 Nov 2026, local Docker database, real Gemini, Mailpit): seeded job with rounds GD -> AI Technical
Interview -> HR Interview and a student who passed GD -> invitation email arrived automatically (names the GD) -> a
spoken interview (TTS-generated answers uploaded through the careers-site proxy): resume-grounded first question,
follow-ups on vague answers, accurate transcripts -> time-out sweep ended it with the answers -> report with evidence
-> HR in Chrome: report + transcript, Advance -> round result 6/10 passed, "cleared, HR Interview next" email sent;
another company's HR got 404. Candidate page in Chrome with a fake camera / microphone: consent, device check, answers,
camera lost -> paused (clock stopped) -> resumed, reload -> "Welcome back" -> same question, phone layout without
horizontal scroll.

## 9. Known limitations

- Live partial transcript is the browser's (Chrome / Edge); no server-side streaming STT (needs a provider account).
- No barge-in: the page does not listen while a question is spoken.
- Speech-to-text accuracy has not been benchmarked (WER, Indian English accents, noise): the transcript quality flags
  and unclear terms are recorded per answer, so a benchmark can use the saved data; plan one before real use.
- A lost connection only pauses the server clock when the pause request gets through (closing the page does, a sudden
  network drop may not). Pauses are capped at 10 minutes.
- Rate limiter and speech cache are per API instance (in memory).
- Protection: the row-lock concurrency path has only been tested against the in-memory store (no database run yet);
  run the protection flow once against PostgreSQL before release. Face counting has not been tried on real cameras /
  low-end laptops yet (false alarms, CPU). It warns by default: test it before real candidates take it. Browsers cannot see other devices or what was opened;
  a candidate can still read from a second screen without focusing it. Tab switches while the interview is paused for
  a device problem are not counted (the clock is stopped, at most 10 minutes in total; HR sees the pauses).
- In one headless-Chrome run with Chrome's fake devices the fake camera reported "ended" right after the first question
  (the page paused correctly); it did not happen again with tracing on. Test on real devices before release.
