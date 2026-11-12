# Proctoring of the DSA and SQL assessments

This document is the reference for the integrity monitoring of the **DSA (coding) and SQL rounds** on the candidate
coding page (`apps/candidate-app`, route `/dsa/[token]`). It covers what the system detects, how warnings and
termination work, where the data lives, the API, configuration, testing and known limits.

Other rounds have their own monitoring and are **not** covered here: the online aptitude test (round engine
`assessment-protection.ts`) and the AI interview (`ai-interview/protection.ts`). All of them share one warning counter
(`countProtectionIncident` in `packages/contracts/src/schemas/protection.ts`).

---

## 1. What proctoring does

During a DSA or SQL attempt the system:

- watches **browser activity**: leaving full screen, switching tab / window, copy / cut / paste, right-click,
  developer-tools / view-source / save / print shortcuts, the PrintScreen key;
- watches the **webcam on the candidate's own computer** (no video leaves it) for four things:
  - **more than one person** in view;
  - **looking away from the screen** continuously for more than 120 seconds;
  - a **phone** in view;
  - the **face not visible** for a sustained time;
- turns confirmed incidents into **Warning 1 and Warning 2**. The **third confirmed incident terminates** the
  assessment. This is enforced by the server;
- gives HR the full incident history, the warnings, the termination and a **review per incident** (Confirmed /
  Dismissed / Requires further review).

Every detection is a *possible* integrity incident, never proof of cheating. Proctoring **never changes a score**.
A terminated attempt is graded on what was submitted and **waits for HR's integrity decision** before anything moves on.

## 2. How it works

```
 Candidate's browser (apps/candidate-app)                API (apps/api, modules/dsa)                    HR dashboard
 ─────────────────────────────────────────              ───────────────────────────────                ────────────
 webcam ─► MediaPipe Face Landmarker (≈5 fps)  ┐
        └► MediaPipe Object Detector (≈1 fps)  ├─► CameraRuleEngine ──► grouped alert ─┐
 browser events (full screen, tabs, keys...)  ─┘   (contracts, pure)                    │
                                                                                         ▼
                                    POST /dsa/:token/proctor/events  ──►  ProctoringService.record()
                                    (batched, each event has an id)        under the record's row lock:
                                                                            1. validate (policy.qualification)
                                                                            2. count (countProtectionIncident)
                                                                            3. Warning 1 / 2, or TERMINATE
                                    ◄── { warning, terminated } ───────────  4. DsaService ends the attempt
 warning dialog / termination screen                                       5. round engine: TERMINATED +
                                                                              INTEGRITY_VIOLATION_REVIEW  ──► review +
                                                                                                             integrity decision
```

**Where processing happens, and why.** Camera analysis runs **in the candidate's browser**, as it already did before
this work. That is the right place for three reasons:

- **Privacy:** no frame, image or face data is ever uploaded. Only short alerts such as `cell phone visible 4 s` are sent.
- **Performance:** there is no video upload, and no GPU or CPU load on the server per candidate. The page throttles
  itself on weak computers.
- **Reliability:** detection keeps working through short network drops, because alerts are queued and retried.

The trade-off is that a page could lie. The server therefore never trusts the page's verdict: it decides which alerts
are confirmed incidents, rejects camera alerts for attempts that are not camera-monitored, and keeps the counter and the
termination to itself. The Python workers are **not** used for proctoring: moving frames to them would upload video
and add load for no accuracy gain.

## 3. Detection methods

All rules live in `packages/contracts/src/schemas/camera-proctoring.ts` (`CameraRuleEngine`). They are pure
TypeScript, unit-tested with synthetic frames, and used by both the page and the tests.

Models are served by the app itself from `public/mediapipe`, never a third-party CDN. They are downloaded once and
verified against a pinned SHA-256 by `apps/candidate-app/scripts/prepare-face-model.mjs`:

| Model | Used for | Rate |
| --- | --- | --- |
| MediaPipe Face Landmarker (`face_landmarker.task`, float16/1) | faces in view, head pose, eye direction, blinks | about 5 frames/s (2/s on slow computers) |
| MediaPipe Object Detector, EfficientDet-Lite0 int8 (`efficientdet_lite0.tflite`) | people and phones in view (COCO `person`, `cell phone`) | about 1 frame/s (every 2 s on slow computers) |

Each model is loaded once per page and reused. Frames are skipped while the tab is hidden; that is already reported as
a tab switch.

### Shared safeguards

- **Sustained conditions.** Every rule uses `SustainedCondition`: the condition must last, and a short gap (a missed
  detection, a blink) does not break it. A single frame never alerts.
- **One alert per occurrence.** A continuing behaviour produces one alert. It must stop and start again, after a
  cool-down, to alert again.
- **Personal calibration.** The candidate's resting head position is learnt in the first frames, so a camera placed
  to the side is not "looking away".
- **Never misconduct:** camera loss, poor lighting and a model that fails are reported as technical events.
- **Never analysed:** emotion, personality or anything else about the face. Only 4 face points, eye scores, and
  object labels with scores are used.

### A. Multiple persons (`CAMERA_MULTIPLE_FACES` → MULTIPLE_PERSONS)

There are two or more people when **either** the face model sees two or more faces, **or** the object detector sees
two or more `person` boxes. A person box counts only with a score of at least 0.6 and at least 3 % of the frame, which
filters out small or far-away photos. The condition must last 3 s, tolerating 2.5 s gaps. At about 1 detection a
second, that means at least three agreeing samples.

### B. Looking away (`CAMERA_GAZE_AWAY` → LOOKING_AWAY)

- A frame counts as "looking away" when the **head** is turned (yaw) or tilted (pitch) beyond its calibrated resting
  position, or when the **eyes are far to one side** while the head is straight.
- The **eyes looking down alone never count**. That is ordinary typing or reading the bottom of the screen, and the
  rule must not rest on eye direction only.
- **Incident:** one continuous look away of **120 s**. The direction may change during it (left, then down). Blinks
  and returns shorter than 0.6 s do not break it; a return to the screen **resets the timer**.
- **Observations, not warnings:** repeated short looks (4 in 60 s) and very frequent head turning are sent to HR as
  context only.

### C. Visible device (`CAMERA_DEVICE_DETECTED` → DEVICE_DETECTED)

- Triggers on a `cell phone` detection with a score of at least 0.5, lasting 3 s with at least 3 agreeing samples.
- Laptops, keyboards, monitors and mice are **not** devices here: they are the candidate's own setup.
- The system says "a phone was visible". It never claims the phone was used.

### D. Face not visible (`CAMERA_FACE_MISSING` → FACE_NOT_VISIBLE)

- An incident is no face for **20 s**. The face must be back for at least 1 s to end an absence, so one wrong "face"
  frame does not reset it.
- If most frames of the absence were too dark, the alert is **DETECTION_UNAVAILABLE** ("poor lighting") instead,
  which is never misconduct.
- The camera stopping (unplugged, turned off, permission withdrawn) is **CAMERA_INTERRUPTED**. It is never
  misconduct; the page blocks the test until the camera is back, and the timer keeps running.

## 4. Warning policy

Implemented exactly as specified:

| Confirmed incident | Action |
| --- | --- |
| 1st | Warning 1 |
| 2nd | Warning 2 (the final one) |
| 3rd | The assessment is terminated automatically |

**What is a confirmed incident:**

- a browser violation (full screen, tab / window switch, clipboard, restricted shortcut, screenshot key);
- or a camera alert that passes **server validation** (`qualification()` in `proctoring.policy.ts`):

| Camera alert | Confirmed when |
| --- | --- |
| Looking away | duration ≥ 120 s **and** confidence ≥ 0.5 |
| Face not visible | duration ≥ 20 s **and** confidence ≥ 0.5 |
| More than one person | duration ≥ 3 s **and** confidence ≥ 0.5 |
| Phone visible | duration ≥ 3 s **and** confidence ≥ 0.5 |
| Head movement, repeated short looks | never (observation) |
| Camera interrupted, detection unavailable | never (technical) |

Anything that fails validation is stored as `RECORDED` with a `note` saying why, for example
`observation: shorter than 120 s, not counted as a warning`.

**Warning manager.** The logic is in `ProctoringService.record()` / `decide()` in
`apps/api/src/modules/dsa/proctoring/proctoring.service.ts`. Inside the record's **row lock** it:

1. **ignores** the event if the attempt is already terminated or ended. Nothing more is processed after termination;
2. **ignores** an event whose `eventId` it has already seen. The page retries after network errors, so a retry never
   counts twice;
3. **validates** the event (above);
4. **counts** it with the shared `countProtectionIncident`:
   - a confirmed incident within 3 s of the previous counted one is the same act (`GROUPED`), for example the
     full-screen exit that Alt+Tab causes;
   - a tab switch that absorbs its own full-screen exit keeps that warning instead of adding one;
5. on the 3rd confirmed incident, **terminates the attempt once**: it sets `terminatedAt` and `terminationReason`.

Because every decision runs under the lock, simultaneous reports can never use up the same warning twice or terminate
twice. This is tested with six concurrent requests.

**Candidate messages** (`packages/contracts/src/schemas/coding-proctoring.ts`). Each warning is shown as a dialog the
candidate must confirm, together with what was detected (for example "A phone was visible in your camera."):

- Warning 1: *"Warning 1 of 2: Potential suspicious activity has been detected during your assessment. Please remain
  alone in the assessment area and keep your attention on the assessment screen. Further confirmed incidents may result
  in assessment termination."*
- Warning 2: *"Warning 2 of 2: Another potential assessment integrity incident has been detected. One more confirmed
  incident will automatically terminate this assessment."*
- Termination: *"Your assessment has been terminated because the maximum number of permitted warnings was exceeded.
  Your assessment activity and incident history have been recorded for review."*

## 5. DSA and SQL warning separation

The counter belongs to the **proctoring record of one attempt**: one row per invitation, keyed by `inviteRef`, a hash
of the link token. A DSA round and a SQL round are separate rounds with separate invitations, so each starts at 0.
A warning in DSA never adds to SQL, and a new attempt (a new invitation) starts at 0. The record stores its `kind`
(`code` / `sql` / `mixed`) so HR sees "DSA assessment" or "SQL assessment". A round that mixes SQL and programming
problems is one attempt with one counter.

## 6. Assessment termination flow

1. The warning manager decides "terminate" under the lock: the record's `terminatedAt` is set once.
2. `DsaService.proctorEvents()` sees `terminated` and ends the attempt with the reason `disqualified`.
3. `EngineSessionStore` → `RoundEngineService.finishCodingAttempt()` → `terminateCodingAttempt()` changes the attempt
   `IN_PROGRESS → TERMINATED` with `integrity_status = INTEGRITY_VIOLATION_REVIEW`, `terminated_at`,
   `termination_reason` and `warning_count`, in **one conditional update** (only an attempt still in progress changes).
   The audit log records `assessment.terminated`.
4. The attempt is **graded** with what was submitted, but **nothing moves on**: no next-round invitation and no email,
   until HR records an integrity decision (Advance / Reject, with a reason). That decision uses the existing round-engine
   flow: `POST /round-engine/applications/:id/rounds/:roundId/integrity-decision`. When it differs from the score, it
   is stored as an audited result override.
5. **Backend enforcement.** From then on, run, submit, finish and new proctoring events are refused with
   `ATTEMPT_ENDED`, whose message is the termination message. If step 2 or 3 failed (for example the database was
   briefly unreachable), the next request for that link sees the terminated record and ends the attempt then. The page
   is never trusted to stop.
6. The page shows the termination message on its final screen.

## 7. Database models

There is **no new table and no migration**. The existing models are reused:

| Table | What it holds for proctoring |
| --- | --- |
| `dsa_proctor_sessions` (`DsaProctorSession.session` JSON) | the proctoring record of one attempt: consent, `kind`, `camera`, `detectionVersion`, `warningCount`, `terminatedAt`, `terminationReason`, and the events. Each event has `id`, `type`, `severity`, `at`, `durationMs`, `confidence`, `detail`, `outcome` (WARNING / TERMINATED / GROUPED / RECORDED), `warningNumber`, `note`, `clientId`, and `review {status, reason, by, at}`. Updated only under `SELECT … FOR UPDATE`. |
| `round_attempts` | the attempt's status (`TERMINATED`), `warning_count`, `integrity_status`, `terminated_at`, `termination_reason`, HR's integrity decision. |
| `audit_logs` | `assessment.terminated`, `proctoring.incident_reviewed`, `assessment.integrity_decided`, result overrides. |

How the specification's incident fields map onto these models:

| Spec field | Where it is |
| --- | --- |
| incident_id | `events[].id`, unique per attempt |
| candidate / application / attempt | the row's `application_id`, `round_id` and `invite_ref` |
| module_type | `session.kind` (DSA / SQL / MIXED) |
| incident_type | `events[].type`, mapped to a category by `proctorIncidentTypeOf()` |
| detected_at | `events[].at` |
| duration | `events[].durationMs` |
| confidence | `events[].confidence` |
| validation_status | `events[].outcome`, plus `note` |
| detection_version | `session.detectionVersion` |
| warning_number | `events[].warningNumber` |
| action_taken | `outcome`, plus `session.terminatedAt` |
| evidence_reference | always `METADATA_ONLY` (see §8) |
| reviewed_by / review_reason | `events[].review` |
| created_at | the row's `created_at` |

**Retention.** The proctoring record belongs to the application (`ON DELETE CASCADE`). It is erased with the
application by the existing data-erasure flow, and there is no other copy.

## 8. Privacy and security

- **Notice and consent.** Before the start, the candidate reads what is monitored, including the warning rule, and
  consents (`CAMERA_CONSENT_VERSION = dsa-proctoring-camera-v4`). A changed notice forces a re-read.
- **No video, no images.** Frames never leave the browser. "Evidence" is metadata only (type, time, duration,
  confidence, short label), so there is no evidence file that a URL could expose.
- **Candidates** can only write events for their own link; the token is the identity, and a body naming anyone else is
  refused. They can never read the event log.
- **HR routes** require an HR session with `jobs.read` (view) or `jobs.write` (review). The company always comes from
  the session, so another company's application or round returns nothing or 404 (tested).
- **Logging:** tokens are never logged; records are keyed by a hash of the token. Audit metadata holds ids, statuses
  and the reviewer's reason only.

## 9. API endpoints

| Method and path | Who | What |
| --- | --- | --- |
| `POST /api/v1/dsa/:token/proctor/start` | candidate | consent (`{ consent, consentVersion, fullscreen, camera }`) |
| `POST /api/v1/dsa/:token/proctor/events` | candidate | up to 20 events `{ type, at?, detail?, eventId?, durationMs?, confidence? }`; answers `{ accepted, ignored, strikesUsed, strikesAllowed, level, warning, terminated, ended }` |
| `GET /api/v1/dsa/:token` | candidate | state; `proctoring` includes `warning` (the latest) and `terminated` |
| `GET /api/v1/dsa-hr/applications/:applicationId/proctoring` | HR (`jobs.read`) | per round: module, warnings, termination, camera, detection version, incidents (category, time, duration, confidence, outcome, warning number, note, evidence, review) |
| `PUT /api/v1/dsa-hr/applications/:applicationId/proctoring/:roundId/incidents/:incidentId/review` | HR (`jobs.write`) | `{ status: CONFIRMED \| DISMISSED \| NEEDS_REVIEW, reason }`; stored with the reviewer and audited; never changes scores or counts |
| `POST /api/v1/round-engine/applications/:applicationId/rounds/:roundId/integrity-decision` | HR (`jobs.write`) | existing: Advance / Reject a terminated attempt, with a reason |

## 10. Configuration and thresholds

API, set in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSA_PROCTOR_MAX_STRIKES` | `2` | warnings allowed; the next confirmed incident terminates (0 = no limit) |
| `DSA_PROCTOR_CAMERA` | `all` | camera on SQL and DSA rounds (`sql` = SQL only, `off` = none) |
| `DSA_PROCTOR_CAMERA_STRIKES` | `on` | `off` = camera alerts are kept for review only, never warnings |
| `DSA_PROCTOR_LOOK_AWAY_SECONDS` | `120` | continuous looking away needed for an incident |
| `DSA_PROCTOR_FACE_MISSING_SECONDS` | `20` | sustained face absence needed |
| `DSA_PROCTOR_MULTI_PERSON_SECONDS` | `3` | how long two or more people must be in view |
| `DSA_PROCTOR_DEVICE_SECONDS` | `3` | how long a phone must be in view |
| `DSA_PROCTOR_CAMERA_MIN_CONFIDENCE` | `0.5` | minimum confidence for a confirmed camera incident |
| `DSA_PROCTOR_CAMERA_COOLDOWN_MS` | `20000` | the same camera alert again within this time is ignored |
| `DSA_PROCTOR_GROUP_SECONDS` | `3` | counted incidents this close together are one act |

The page-side rules are `CAMERA_RULES_DEFAULTS` in contracts. Their incident thresholds come from
`CAMERA_CONFIRM_DEFAULTS`, so the page and the server agree. **If you change a server threshold, change
`CAMERA_CONFIRM_DEFAULTS` too.** Otherwise the page may send alerts the server will not confirm, or no alerts at all.

**Why these numbers:**

- **120 s look away** is the business rule.
- **20 s face missing** leaves room for adjusting the chair, picking something up or a lighting flicker. A face that
  cannot be checked for longer than that is a real gap.
- **3 s for people and phones** means about three agreeing samples at 1 per second. One wrong frame never counts, and
  someone walking past rarely stays that long.
- **0.6 person score and 3 % area** filter out photos and far-away figures.
- **0.5 phone score** is MediaPipe's usual cut-off.

They are tested with synthetic frames, not yet tuned on real recordings (§12).

## 11. How to run and test

```powershell
pnpm install
node apps/candidate-app/scripts/prepare-face-model.mjs          # models -> apps/candidate-app/public/mediapipe (also runs before dev/build)
cd packages/contracts; npx tsc -p tsconfig.json                 # the API uses the built contracts

# tests
cd packages/contracts; npx vitest run tests/camera-proctoring.test.ts      # detection rules (29 tests)
cd apps/api; npx vitest run tests/dsa-proctoring-warnings.test.ts           # warning manager, termination, HR review (19)
cd apps/api; npx vitest run tests/dsa-proctoring.test.ts tests/dsa-proctoring.e2e.test.ts tests/sql tests/round-engine
```

To try it by hand, start the stack (`scripts/start-public.ps1`). Create a job with a DSA or SQL round after Aptitude,
open a candidate's coding link, allow the camera, then hold a phone in view for a few seconds. Warning 1 appears.
`DSA_DEMO_MODE=on` serves the built-in demo token `demo-dsa-token` without a job; everything is then kept in memory.

## 12. Known limitations

- **Estimates, not proof.** Head pose and eye direction are estimated from 2D landmarks. Glasses, unusual camera
  angles or low resolution reduce accuracy. A poster or photo of a person can count as a person or face, and a phone
  lying face-down may or may not be detected.
- **Thresholds are not yet tuned on real data.** They come from reasoning and synthetic tests (§10). Collecting
  consented sample sessions and measuring false-positive rates is the next step.
- **The page can be tampered with.** A determined candidate could disable the page's JavaScript camera checks. The
  server refuses to start without camera consent and blocks fabricated camera alerts, but cannot prove the camera
  really runs. Nothing is uploaded by design, so there is no server-side cross-check.
- **Browser activity also counts** towards the same two warnings, as it did before this work (for example leaving
  full screen or a paste attempt). Set `DSA_PROCTOR_CAMERA_STRIKES=off` to keep camera alerts review-only, or
  `DSA_PROCTOR_MAX_STRIKES` to change the limit.
- **No evidence snapshots.** HR sees metadata only. This is a deliberate privacy choice; see the next section.
- **The old webcam event types** (`NO_FACE`, `MULTIPLE_FACES`, `CAMERA_OFF`) from older pages are recorded but never
  become warnings: they carry no duration to validate.

## 13. Future improvements (not implemented)

- Measure false-positive and false-negative rates on consented sample sessions, then tune the thresholds.
- An optional, consented, short-lived **evidence snapshot** on a confirmed incident: encrypted, HR-only, deleted after
  a set retention. It needs a privacy review first.
- A per-job HR setting for the warning limit (it is currently server-wide).
- More device classes (tablets, earphones), which need a model trained beyond COCO.
- Showing the HR incident reviews on the Assessments board summary.

---

### Files

| Area | File |
| --- | --- |
| Detection rules (shared) | `packages/contracts/src/schemas/camera-proctoring.ts` |
| Warning texts, incident categories, review statuses | `packages/contracts/src/schemas/coding-proctoring.ts` |
| Shared warning counter | `packages/contracts/src/schemas/protection.ts` |
| Validation, thresholds, summary | `apps/api/src/modules/dsa/proctoring/proctoring.policy.ts` |
| Warning manager | `apps/api/src/modules/dsa/proctoring/proctoring.service.ts` |
| Row-locked store | `apps/api/src/modules/dsa/proctoring/prisma-proctor.store.ts`, `proctoring.store.ts` |
| HR review | `apps/api/src/modules/dsa/proctoring/proctoring-hr.service.ts`, `dsa-hr.controller.ts` |
| Termination enforcement | `apps/api/src/modules/dsa/dsa.service.ts` |
| Attempt termination, integrity review | `apps/api/src/modules/round-engine/round-engine.service.ts` (`terminateCoding`) |
| Camera loop, models | `apps/candidate-app/src/app/dsa/[token]/camera-monitor.tsx`, `face-model.ts` |
| Warning dialog | `apps/candidate-app/src/app/dsa/[token]/proctoring.tsx` |
| HR incident history and review | `apps/hr-dashboard/src/components/online-test-panel.tsx` |
| Tests | `packages/contracts/tests/camera-proctoring.test.ts`, `apps/api/tests/dsa-proctoring-warnings.test.ts`, `apps/api/tests/sql/sql-camera-proctoring.test.ts` |
