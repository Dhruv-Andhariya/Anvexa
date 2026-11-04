# DSA assessment: browser proctoring

> **Update (2026-11-02): code execution now runs on Piston, not Judge0.** The test sections below are a record of the proctoring change as it was verified at the time, when Judge0 was the runner; "real Judge0" and `dsa-judge0.integration.test.ts` there refer to that earlier setup, and that test file no longer exists. After the switch the proctoring browser suite was re-run against Piston: **56 / 56 checks passed**, including Run and Submit under proctoring. Current test counts and hosting: [dsa-integration-notes.md](dsa-integration-notes.md) §7 and [dsa-piston-hosting.md](dsa-piston-hosting.md).

Browser-based integrity monitoring for the DSA coding assessment: full-screen mode, tab and window focus, clipboard and restricted shortcuts, with server-side violation records, a review policy and an HR reporting contract.

> **What this is, and is not.** It is *browser-level detection and deterrence*. A normal web page cannot lock down a computer. It cannot see other applications, block operating-system shortcuts (Alt+Tab, the Windows key, Ctrl+T/W), stop a second device, or know why the browser reported an event. Every record is an **observation for a human reviewer, never proof of cheating**, and nothing here changes a candidate's score. See [Security limitations](#7-security-limitations).
>
> **Webcam (2026-11-04, `DSA_PROCTOR_CAMERA`, default on).** The webcam must be on to start and for the whole attempt. A face detector (MediaPipe BlazeFace, running in the candidate's browser, one frame a second) reports `NO_FACE` (no face for 8 s), `MULTIPLE_FACES` (more than one face for 3 s, high severity) and `CAMERA_OFF` (the camera stopped or its permission was withdrawn; the page is blocked until it is back on). Each is one warning, at most once per episode. The video never leaves the device; only these events reach the server. Code: `apps/candidate-app/src/app/dsa/[token]/webcam.tsx`. The detector is served by the candidate app itself (runtime copied to `public/mediapipe/wasm` before dev / build by `scripts/copy-face-detector.mjs`, model committed in `public/models`), overridable with `NEXT_PUBLIC_FACE_WASM_URL` / `NEXT_PUBLIC_FACE_MODEL_URL`; if it cannot load, only the camera-on check runs. Consent version `dsa-proctoring-v2`.
>
> **Allowed warnings (default 3).** The first 3 suspicious events (any violation below: a screenshot key, a tab switch, leaving full screen, a copy attempt, the webcam turning off, no face or a second face in view, and so on, one per real action) are tolerated and shown to the candidate as warnings. **The next one ends the assessment immediately**, including leaving full screen, and the work submitted so far is kept. See [Allowed warnings](#allowed-warnings-the-two-strike-rule). Set `DSA_PROCTOR_MAX_STRIKES=0` for no limit.

Related: [dsa-integration-notes.md](dsa-integration-notes.md) (the assessment module this extends).

---

## 1. Architecture

```
Candidate browser (apps/candidate-app, /dsa/[token])            API (apps/api/src/modules/dsa)
  IntroScreen: notice + consent + "Start in full screen"
      │ click → requestFullscreen()  (needs the user gesture)
      │ POST /dsa/:token/proctor/start   {consent, consentVersion, fullscreen} ─►  ProctoringService.start  (consent stored)
      │ POST /dsa/:token/start                                                  ─►  DsaService.start  (refused until consent exists)
  useProctoring()  (only while the attempt is in progress)
      listeners → dedupe/merge on the page → queue → POST /dsa/:token/proctor/events ─► ProctoringService.record
      FullscreenGate: blocks the page until full screen returns (policy "block")        validates, clamps time, merges, stores
  ProctorNotice: tells the candidate what was recorded and how many                      ◄─ { accepted, violationCount, level }
                                                                                    finish / time-out / auto-end ─► ProctoringService.end (seal, close open episodes)
HR (their dashboard)  ──x-dsa-admin-key──►  GET /dsa-admin/proctoring/{flagged | :inviteRef/summary | :inviteRef/events}
```

Design decisions:

- **Isolated.** All code is in `modules/dsa/proctoring/` plus small hooks in `DsaService`. The existing `modules/proctoring` (owned by another developer) is only a README stub in this snapshot, so there was nothing to reuse and nothing was changed. Event names that already exist in the round-engine's online-test proctoring (`TAB_SWITCH`, `FULLSCREEN_EXIT`) are kept identical so the two logs can later be merged on one timeline.
- **The server is the source of truth.** The browser reports raw signals. The server assigns severity, computes durations, counts, the score and the status. The candidate's page never sends or receives a final count it must be trusted for.
- **Identity comes only from the invitation token in the URL.** Bodies that name a candidate, assessment or invitation are refused (`400 UNEXPECTED_FIELD`). There is no field through which another candidate's record could be addressed.
- **Swappable parts** (same pattern as the rest of the module): `ProctorStore` (`DSA_PROCTOR_STORE`), policy (`DSA_PROCTOR_POLICY`), invitation resolver. Storage is in memory for now.

### Files

Backend, `apps/api/src/modules/dsa/`: `dsa.tokens.ts` (shared clock token), `proctoring/proctoring.types.ts`, `proctoring.policy.ts`, `proctoring.store.ts`, `proctoring.dto.ts`, `proctoring.service.ts`, `proctoring.controller.ts` (candidate routes), `proctoring-admin.controller.ts` (HR routes). Modified: `dsa.service.ts` (consent gating, ending, auto-end, state), `dsa.module.ts` (providers/controllers), `session/session.store.ts` (finish reason `disqualified`).

Frontend, `apps/candidate-app/src/`: `lib/dsa-api.ts` (types, `startProctoring`, `sendProctorEvents`), `app/dsa/[token]/proctoring.tsx` (hook, full-screen helpers, gate, notice), `proctoring-rules.ts` (key classification), and edits to `assessment.tsx`, `screens.tsx` (consent screen, end message), `code-editor.tsx` (`data-code-editor` marker).

Tests, `apps/api/tests/`: `dsa-proctoring.test.ts`, `dsa-proctoring.e2e.test.ts`.

---

## 2. Candidate flow

1. **Instructions and notice.** The start screen explains the full-screen requirement, lists every monitored event, lists what is *not* collected, and states that a web page cannot lock the computer. *Start in full screen* stays disabled until the candidate ticks the consent box.
2. **Explicit start.** On click the page requests full screen *synchronously in the click handler* (browsers require the gesture). The assessment starts only if full screen was granted **and** the server accepted the consent. If either fails, nothing starts and the candidate sees why (e.g. full screen refused, or a browser without the Fullscreen API).
3. **During the attempt.** Monitoring runs only while the attempt is in progress. A *Monitored · n* badge is always visible. Each recorded event shows a short notice (what was recorded, count so far).
4. **Leaving full screen.** With policy `block` (default) a modal covers the page, and the page behind it is `inert` (not usable), until the candidate returns to full screen. The timer keeps running and the code is kept. With policy `warn` only a banner is shown.
5. **Reload mid-attempt.** The attempt continues (server timer). The gate asks for full screen again. A `SESSION_RESUMED` info event is stored (not counted as a violation).
   Each suspicious event shows a warning such as "Warning 1 of 2". The *Monitored* badge shows "warnings 1/2". After the last allowed warning the notice says the next suspicious activity, including leaving full screen, ends the assessment.
6. **Strike-out.** The next suspicious event after the allowed warnings ends the assessment on the server at once. The candidate lands on the result screen ("ended automatically because the allowed number of warnings was used up"), with the score earned so far, and cannot return (further runs, submissions and events are refused with 403).
7. **End.** On finish, time-out or policy end, monitoring stops, full screen is released, and the result screen shows nothing about integrity. Remaining events are flushed first.

---

## 3. Browser APIs and what each is used for

| API | Use |
|---|---|
| `Element.requestFullscreen()` / `document.exitFullscreen()` / `document.fullscreenElement` / `fullscreenchange` | Enter full screen from the start click and from the re-entry button; detect leaving and returning. |
| `document.visibilitychange` / `document.hidden` | Tab switch and return. |
| `window` `blur` / `focus` + `document.hasFocus()` | Window focus loss while the tab stays visible. A blur is held back **1 s**: it is dropped if the tab turns out to be hidden (a tab switch is reported once, as that) and ignored if focus returns within that second (a notification toast or pop-up is not a deliberate action). The record is timestamped from the moment focus was actually lost. |
| `copy`, `cut`, `paste`, `drop`, `dragover`, `contextmenu` (capture phase, `preventDefault`) | Block and record clipboard use, drag-and-drop of text into the editor and the right-click menu. |
| `keydown` and `keyup` (capture phase, matched on `KeyboardEvent.code`) | Block and record the restricted shortcuts listed below. `keyup` is also watched because Windows reports **PrintScreen** on key release only. |
| `pagehide` | Flush queued events when the page is closed. |
| CSS `user-select: none` on the question panel; `inert` on the page behind the full-screen gate | Make question text unselectable; make the page unusable while the gate is up. |

### Shortcuts

**Screenshots: detected, not blocked.** The PrintScreen key (and Cmd+Shift+3/4/5 on macOS, when the browser receives them) is recorded as `SCREENSHOT_ATTEMPT` and counts as a warning. A web page **cannot prevent** a screenshot, and cannot see Win+Shift+S (Snipping Tool), the Snipping Tool itself, other screenshot apps, screen sharing or a phone camera, because the operating system handles those before the browser. Only the PrintScreen key reaches the page on Windows.

Blocked and recorded: Ctrl/Cmd+C, +X, +V (and Ctrl+Insert, Shift+Insert, Shift+Delete), Ctrl/Cmd+U (view source; also Cmd+Option+U), Ctrl/Cmd+S, Ctrl/Cmd+P, F12, Ctrl/Cmd+Shift+I, +J, +C, Ctrl+Shift+K, Cmd+Option+I/J/C, and Ctrl/Cmd+A **outside the code editor**.

Never blocked or recorded (checked in a real browser): typing, Tab (indentation), Enter (auto-indent), Backspace, arrow keys, Home/End, Ctrl+Left/Right, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, and **Ctrl+A inside the editor**. Select-all in the editor is a normal editing action. Copy and cut stay blocked, so it cannot be used to lift text out. AltGr combinations (which type characters on many keyboard layouts) are ignored.

---

## 4. Violation model

### Event types

| Type | Kind | Severity |
|---|---|---|
| `FULLSCREEN_EXIT` | episode (has a duration) | **medium**; **high** from the Nth exit on (default 3) |
| `TAB_SWITCH` | episode | medium |
| `WINDOW_BLUR` | episode | medium |
| `DEVTOOLS_SHORTCUT` | instant | medium |
| `SCREENSHOT_ATTEMPT` | instant | medium |
| `CAMERA_OFF`, `NO_FACE` | instant | medium |
| `MULTIPLE_FACES` | instant | **high** |
| `COPY`, `CUT`, `PASTE`, `SELECT_ALL`, `CONTEXT_MENU`, `VIEW_SOURCE`, `SAVE_SHORTCUT`, `PRINT_SHORTCUT` | instant | low |
| `SESSION_RESUMED` | info | not a violation, not scored |

`FULLSCREEN_RETURN`, `TAB_RETURN` and `WINDOW_RETURN` are *input only*: they close the matching open episode and set its duration. They are never stored as records.

### Stored record (`ProctorEvent`)

```json
{ "id": 7, "type": "TAB_SWITCH", "severity": "medium",
  "at": "2026-11-02T06:42:10.120Z", "endedAt": "2026-11-02T06:42:12.695Z", "durationMs": 2575, "detail": null }
```

`detail` is a short sanitised label such as `"Ctrl+Shift+I"` (control characters stripped, max 60 characters). Each stored session also keeps: `inviteRef`, `assessmentId`, consent version/time, whether the page said full screen was on at consent, start/end time, and a count of dropped events.

### De-duplication and merging (server and page)

- The same type within 400 ms is one action reported twice (a key event plus a clipboard event). The page also drops repeats within 300 ms.
- A window blur next to a tab switch is the same action: only the tab switch is kept.
- **Chrome leaves full screen by itself when you switch tabs.** Verified in a real browser: `fullscreenchange(false)` fires about 3 ms before `blur` and `visibilitychange(hidden)`. That full-screen exit is merged into the tab switch (in either order), and the tab switch keeps the earliest timestamp. The re-entry gate still makes the candidate return to full screen. Without this merge, every tab switch would also be counted as a full-screen exit.
- An episode that is already open cannot start again; a return with nothing open is ignored.
- At most 500 events per attempt (configurable); extra events are counted in `droppedEvents`.

### Time handling

The server never trusts the page's clock. A client timestamp is accepted only inside the attempt window (start → now/deadline) and is clamped otherwise; with no timestamp the server's time is used. Episode durations are computed by the server from those times. Open episodes are closed at the end of the attempt. **Not measured:** time away while the page is closed or reloading (recorded only as `SESSION_RESUMED`).

### Allowed warnings (the two-strike rule)

`DSA_PROCTOR_MAX_STRIKES` (default **3**, `0` = no limit; the table below shows the rule with 2). A *strike* is one stored violation record, so one real action counts once (a tab switch with Chrome's own full-screen exit and window blur is a single strike; a key press plus its clipboard event is a single strike; `SESSION_RESUMED` is not a strike).

| Strikes used | What the candidate sees | What happens |
|---|---|---|
| 1 | "Warning 1 of 2" | continues |
| 2 | "Warning 2 of 2. That was your last allowed warning. The next suspicious activity, including leaving full screen, ends your assessment immediately." | continues |
| 3 (the next one) | result screen: "ended automatically because the allowed number of warnings was used up" | **the server ends the attempt at once**: status `finished`, `finishReason: disqualified`, the best submitted score per question is kept, further runs, submissions and events get `403 ATTEMPT_ENDED`, the proctoring record is sealed |

HR sees status `disqualified`, `flagged: true`, `strikesUsed: 3 / strikesAllowed: 2` and the reason "Used all 2 allowed warnings; suspicious event number 3 ended the assessment." Ending is decided on the server when the event arrives, not by the page. The intro screen tells the candidate about this rule before they consent. Because any violation counts, **accidental events cost a warning too** (right-click, a copy shortcut out of habit, a pop-up that takes focus for more than a second). Raise `DSA_PROCTOR_MAX_STRIKES` if that is too strict for your candidates, and review ended attempts before acting on them: the rule is automatic, the hiring decision should not be.

### Policy (all configurable)

Score = low×1 + medium×3 + high×5. The score-based statuses below are in addition to the warnings rule above.

| Status | When (defaults) | Effect |
|---|---|---|
| `clean` | below the warning threshold | none |
| `warning` | score ≥ 5 | the candidate sees a warning notice |
| `review` | score ≥ 12, **or** ≥ 3 full-screen exits, **or** ≥ 60 s merged time outside | **flagged** for a human; the candidate sees a "final warning" notice |
| `disqualified` | score ≥ `DSA_PROCTOR_DISQUALIFY_SCORE` (default **0 = never**) | flagged. The attempt keeps running unless `DSA_PROCTOR_AUTO_END=on`; then it ends (`finishReason: disqualified`) and the answers so far are kept |

| Env var | Default | Meaning |
|---|---|---|
| `DSA_PROCTORING` | `on` | `off` disables everything: no gating, no events |
| `DSA_PROCTOR_REQUIRE_FULLSCREEN` | `on` | Start only in full screen |
| `DSA_PROCTOR_FULLSCREEN_REENTRY` | `block` | `block` (page unusable) or `warn` (banner) |
| `DSA_PROCTOR_WARN_SCORE` | `5` | Warning threshold |
| `DSA_PROCTOR_REVIEW_SCORE` | `12` | Review threshold |
| `DSA_PROCTOR_DISQUALIFY_SCORE` | `0` | Disqualification threshold (0 = off) |
| `DSA_PROCTOR_REVIEW_FULLSCREEN_EXITS` | `3` | Exits that flag for review (0 = off) |
| `DSA_PROCTOR_REVIEW_OUTSIDE_SECONDS` | `60` | Merged seconds away that flag for review (0 = off) |
| `DSA_PROCTOR_MAX_STRIKES` | `3` | Allowed warnings; the next suspicious event ends the assessment (0 = no limit) |
| `DSA_PROCTOR_CAMERA` | `on` | Webcam required: `CAMERA_OFF`, `NO_FACE`, `MULTIPLE_FACES` are reported (`off` = no camera) |
| `DSA_PROCTOR_AUTO_END` | `off` | End the attempt when the *score* reaches the disqualification threshold |
| `DSA_PROCTOR_FULLSCREEN_HIGH_AFTER` | `3` | From this exit on, each exit is *high* |
| `DSA_PROCTOR_MAX_EVENTS` | `500` | Cap per attempt |
| `DSA_PROCTOR_DEDUPE_MS` / `_MERGE_MS` | `400` / `1500` | De-duplication and blur/full-screen merge windows |
| `DSA_ADMIN_API_KEY` | unset | Enables the HR routes (see below); unset = they return 404 |

The candidate is told how they are doing (`violationCount`, `strikesUsed` / `strikesAllowed`, `level`: `ok` / `warning` / `final_warning`) but never the score thresholds or the event log. With the warnings rule on, `level` is `warning` after the first strike and `final_warning` once the last allowed warning is used.

---

## 5. API

Base `/api/v1`. Errors are `{ statusCode, code, message }`.

### Candidate (identity = the token in the URL)

| Method | Path | Purpose |
|---|---|---|
| POST | `/dsa/:token/proctor/start` | Body `{ "consent": true, "consentVersion": "dsa-proctoring-v1", "fullscreen": true }`. Records consent. Idempotent. Must precede `/start` when proctoring is on. Returns the client config. |
| POST | `/dsa/:token/proctor/events` | Body `{ "events": [{ "type": "TAB_SWITCH", "at": 1700000000000, "detail": "…" }] }`, 1 to 20 per call. Returns `{ accepted, ignored, violationCount, level, ended }`. Only while the attempt is in progress. |
| POST | `/dsa/:token/proctor/end` | Seals proctoring; only after the assessment is finished (it also seals itself on finish, time-out and auto-end). |
| GET | `/dsa/:token` | Existing state, now with `proctoring: { enabled, requireFullscreen, fullscreenReentry, autoEnd, consentVersion, monitored[], started, violationCount, level }`. |

Refusals: `400 CONSENT_REQUIRED | FULLSCREEN_REQUIRED | UNEXPECTED_FIELD | INVALID_EVENT_TYPE | TOO_MANY_EVENTS | INVALID_REQUEST`, `404 INVALID_TOKEN | PROCTORING_DISABLED`, `409 PROCTORING_NOT_STARTED | CONSENT_OUTDATED | NOT_STARTED | ASSESSMENT_IN_PROGRESS`, `403 ALREADY_FINISHED | TIME_EXPIRED | ATTEMPT_ENDED`. Candidates **cannot read** the event log or summary (those routes do not exist for them: 404).

### HR / reviewer (temporary key guard)

Header `x-dsa-admin-key: <DSA_ADMIN_API_KEY>`. Records are addressed by `inviteRef`, a 24-character SHA-256-derived reference of the invitation token (the raw token is never stored with proctoring data). `inviteRefFor(token)` is exported from `proctoring.service.ts`.

| Method | Path | Returns |
|---|---|---|
| GET | `/dsa-admin/proctoring/flagged` | `{ flagged: ProctoringSummary[] }`, attempts with status `review` or `disqualified`, highest score first |
| GET | `/dsa-admin/proctoring/:inviteRef/summary` | `ProctoringSummary` |
| GET | `/dsa-admin/proctoring/:inviteRef/events?limit=100&offset=0` | `{ total, events: ProctorEvent[] }`, oldest first, limit ≤ 500 |

`ProctoringSummary`:

```json
{ "assessmentId": "demo-assessment", "inviteRef": "9f2c…", "status": "review", "flagged": true,
  "reasons": ["Left full screen 3 times (review at 3)."],
  "totalViolations": 19, "bySeverity": { "low": 12, "medium": 6, "high": 1 }, "score": 31,
  "tabSwitchCount": 1, "windowBlurCount": 0, "fullscreenExitCount": 3,
  "copyPasteAttempts": 8, "contextMenuAttempts": 1, "devToolsAttempts": 4, "otherRestrictedActions": 4,
  "screenshotAttempts": 1, "strikesAllowed": 2, "strikesUsed": 3,
  "totalTimeOutsideMs": 4926, "sessionResumes": 1, "droppedEvents": 0,
  "consent": { "version": "dsa-proctoring-v1", "at": "ISO", "fullscreenAtStart": true },
  "startedAt": "ISO", "endedAt": "ISO",
  "policy": { "warnScore": 5, "reviewScore": 12, "disqualifyScore": 0, "reviewFullscreenExits": 3, "reviewOutsideSeconds": 60, "autoEnd": false, "maxStrikes": 2 } }
```

**The key guard is a placeholder.** Real HR authentication belongs to the auth module (another developer). Replace `requireAdmin()` in `proctoring-admin.controller.ts` with the HR session and permission check (e.g. `jobs.read`, with a tenant check) when integrating. With no key configured the routes do not exist.

---

## 6. Database changes

**None applied.** This snapshot has no connection to the shared database, and a migration on it needs the schema owner's review. Storage today is `InMemoryProctorStore` (lost on API restart), behind the `ProctorStore` interface. The proposed additive migration, to be reviewed and applied by whoever owns the Prisma schema:

```prisma
model DsaProctorSession {
  id                String   @id @default(uuid()) @db.Uuid
  tenantId          String   @map("tenant_id") @db.Uuid
  applicationId     String?  @map("application_id") @db.Uuid      // from the invitation, once integrated
  inviteRef         String   @unique @map("invite_ref")            // hash of the token, never the token
  assessmentId      String   @map("assessment_id")
  consentVersion    String?  @map("consent_version")
  consentAt         DateTime? @map("consent_at")
  fullscreenAtStart Boolean  @default(false) @map("fullscreen_at_start")
  startedAt         DateTime? @map("started_at")
  endedAt           DateTime? @map("ended_at")
  dropped           Int      @default(0)
  summary           Json?                                          // sealed ProctoringSummary at the end
  events            DsaProctorEvent[]
  @@index([tenantId])
  @@map("dsa_proctor_sessions")
}

model DsaProctorEvent {
  id         BigInt   @id @default(autoincrement())
  sessionId  String   @map("session_id") @db.Uuid
  type       String
  severity   String
  at         DateTime
  endedAt    DateTime? @map("ended_at")
  durationMs Int?      @map("duration_ms")
  detail     String?   @db.VarChar(60)
  session    DsaProctorSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId, at])
  @@map("dsa_proctor_events")
}
```

Rows should be deleted with the application (`ON DELETE CASCADE` through `applicationId`), matching how the round-engine's proctoring events are handled. Add a CHECK that `ended_at >= at`.

---

## 7. Security limitations

Stated plainly, because a proctoring page is easy to over-sell:

- **A page only sees what the browser tells it.** Alt+Tab, the Windows/Cmd key, Ctrl+T / Ctrl+W / Ctrl+N, Ctrl+Shift+Delete, screenshots, screen sharing, a second monitor, a phone, a second computer, and virtual machines are invisible and cannot be blocked from a web page. Esc exits full screen regardless of the page.
- **Screenshots cannot be prevented.** The page only notices the PrintScreen key (and Cmd+Shift+3/4/5 when the browser receives it). Win+Shift+S, the Snipping Tool, third-party screenshot or recording software, screen sharing, a phone camera and remote-desktop tools are invisible to a web page. A candidate can screenshot without ever triggering a warning.
- **False positives are possible, and each one costs a warning.** The two-strike rule is automatic. Real people trigger events by accident: a right-click, a habitual Ctrl+C, a pop-up or an OS dialog that holds focus for more than a second, clicking the browser's address bar, an accessibility tool or a screen reader that sends its own key events. Candidates are told the rule before they start, but review ended attempts and consider raising `DSA_PROCTOR_MAX_STRIKES`.
- **Dev-tools shortcuts are deterrence, not prevention.** The page can cancel F12 and Ctrl+Shift+I where the browser passes the key to it, but dev tools can be opened from the browser menu or already be open, and they can be detached. The page does not detect an open dev-tools panel.
- **Copy/paste blocking is best-effort.** It stops the keyboard shortcuts, the context menu and the clipboard and drop events in this page. It does not stop typing code from another screen, and it cannot stop text being copied *into* the clipboard by something outside the page.
- **A determined candidate can defeat client-side monitoring** by disabling JavaScript, blocking the requests, modifying the page, or using a modified browser. There is no heartbeat check yet: a client that goes silent is not flagged. A server-side "no signal for N seconds" rule would be a sensible next step.
- **Events can be absent but not forged against someone else.** Events can only be written for the token holder; the server rejects bodies that name another identity, clamps times, caps volume and de-duplicates. A candidate can only under-report or over-report *their own* events.
- **Full-screen state at consent is a claim from the page.** The server records it but cannot verify it.
- **iOS Safari has no Fullscreen API for pages**, so the assessment cannot start there while full screen is required. Real Firefox, Edge and Safari behaviour and macOS shortcuts were not tested (see §9).
- **Admin routes use a temporary shared key** (§5). Treat the key as a secret and replace the guard before real use.
- **Storage is in memory** until the migration in §6 is applied.

## 8. Privacy and transparency

- The candidate is told **before** monitoring begins, on the start screen, which events are monitored, what is *not* collected, why, and who sees it. Consent is explicit (checkbox) and stored with a version and time. Starting is impossible without it.
- **Collected:** event type, time, duration, and a short shortcut label (e.g. `Ctrl+Shift+I`). **Not collected:** camera, microphone, screen, other tabs or applications, passwords, clipboard contents, typed text, IP address or device fingerprints. No video or image is captured or stored.
- Events are kept with the assessment record and shown to the hiring team as *observations*. The result screen never shows integrity information. By default the first two suspicious events are warnings and the third ends the assessment automatically (the candidate is told this before consenting, and the work submitted so far is kept). Score-based disqualification is off by default, and the hiring team still decides what an ended attempt means.
- **Pseudonymous reference:** proctoring data is keyed by a hash of the invitation token, not by name or email.
- **Retention:** not defined by this module. Decide a retention period before real use, and delete with the application record (§6). This document is not a statement of legal compliance (GDPR, DPDP or other); get that reviewed for your jurisdiction.

---

## 9. Tests (actually executed)

Last run 2026-11-02, on the code as delivered.

### Builds and type checks

| Check | Result |
|---|---|
| `apps/candidate-app`: `pnpm typecheck` | passed, no errors |
| `apps/candidate-app`: `pnpm build` | passed |
| `apps/api`: `pnpm typecheck` | passed, no errors |
| `apps/api`: `pnpm build` | passed |

### API test suite: 7 files, 124 tests

Run with `vitest run --exclude tests/dsa-judge0.integration.test.ts`. That file (38 tests against the live Judge0) was **not re-run** for these changes, because it takes about 25 minutes on this PC and proctoring does not touch code execution. Real Judge0 Run and Submit were exercised in the browser tests below instead.

**First full run: 123 passed, 1 failed.** The failure was `dsa-local-runner.test.ts`, "dsa-001 java: correct solution passes every sample + hidden test". It **passed when run alone** (14 s) and the whole `dsa-local-runner.test.ts` file then **passed 38 of 38 on a rerun**. The cause of the single failure was **not established**. The likeliest explanation is the 4 s per-test limit of the local test runner while the PC was busy with servers and builds, but that is a guess. The 35 + 5 + 29 + 2 + 4 + 11 tests of the other six files passed in that run.

| File | Tests | Covers |
|---|---|---|
| `dsa-proctoring.test.ts` | 35 | **Allowed warnings (8 tests):** default of 2; two tolerated with the warning counts; the third ends the assessment and keeps the score; leaving full screen ends it only after the allowance is used; one real action counts once (tab switch + browser full-screen exit + blur); info events and screenshot attempts; HR sees `disqualified` with the reason; a limit of 0 means no limit. **Earlier (27 tests):** Consent gating; start refused without consent; consent validation; no thresholds exposed; events refused before start and after finish; full-screen exit with duration; same-action de-duplication; blur, full-screen exit and tab-switch merging in both orders (including Chrome's real event order); open-episode and stray-return handling; severity escalation of repeated exits; severities per type; client-time clamping; event cap; fabricated identity fields refused; unknown types, empty and oversized batches, label sanitising; per-candidate separation; only a hash stored; warning, review and disqualification thresholds; no disqualification by default; auto-end keeping the work done; sealing on finish and at the time-out deadline; scoring unaffected; flagged list order |
| `dsa-proctoring.e2e.test.ts` | 5 | Real HTTP through the Nest controllers: consent then start, recording, candidate view without thresholds, forged-identity and malformed bodies, candidates cannot read the log, admin key guard (missing, wrong, token as key, correct, and no key configured = 404), end only after finish |
| `dsa-unit.test.ts` | 29 | Existing DSA unit tests, unaffected |
| `dsa-http.e2e.test.ts` | 2 | Existing HTTP flow and hidden-data scan, unaffected |
| `dsa-local-runner.test.ts` | 38 | Existing end-to-end execution suite (3 questions × Python, Java, C++), unaffected. Uses local toolchains, not Judge0 |
| `resume-score.test.ts`, `jd-generation.test.ts` | 4 + 11 | Pre-existing tests, unaffected |

### Browser tests (Chrome, headless, real keyboard and focus events; scripts are kept outside the repo)

**Allowed-warnings run (default policy): 24 of 24 checks passed**, real Chrome, real Judge0:

- The intro screen states the rule (2 allowed suspicious actions, then the next one ends the assessment, the submitted answers are kept) and names the PrintScreen key.
- A correct Python submission was scored 10/10 (real Judge0). The **PrintScreen key** was noticed: "Warning 1 of 2", badge "warnings 1/2". A **right-click** was warning 2: "last allowed warning", assessment still running.
- **Leaving full screen** was the third: the assessment ended immediately, the result screen explained why in plain words, the 10/60 earned score was kept, full screen was released.
- HR summary: `disqualified`, flagged, 3 of 2 allowed used, 1 screenshot attempt, 1 context-menu attempt, 1 full-screen exit, reason text, record sealed, listed in `/flagged`. Running code and sending events afterwards got 403, and a reload could not get back in.
- A **real tab switch** (Chrome also exits full screen and blurs the window) cost exactly **one** warning, and the gate then asked for full screen again.

One observation, **not explained**: in an earlier run of this scenario a single 13.7 s `WINDOW_BLUR` was recorded while a Judge0 submission was running, which used up a warning and made the scenario fail. Two replays of the same steps with focus logging, and the full rerun above, did not show it again. Focus loss now has to last 1 s to count, which removes short flickers but would not have prevented a 13.7 s loss. If you see a warning you did not cause, treat it as possible, and review ended attempts.

**Proctoring run: 56 of 56 checks passed** (run with `DSA_PROCTOR_MAX_STRIKES=0`, because these checks deliberately trigger about 19 violations), against the real API with the real Judge0. Covered:

- **Start:** the notice lists the monitored events and what is not collected, and admits a page cannot lock the computer. Start is disabled until consent. Consent reaches the server before the assessment starts. Full screen is entered successfully (`document.fullscreenElement` set).
- **Normal coding is untouched:** typing, Tab indentation, Enter auto-indent, Backspace, arrows, Ctrl+Left, Home, Ctrl+Z (undo really undoes), Ctrl+Y, Ctrl+Shift+Z and Ctrl+A *inside* the editor are not blocked and produce no violation record.
- **Restrictions work:** Ctrl+C/X/V, Ctrl+U/S/P, F12, Ctrl+Shift+I/C/J are cancelled. Pasting inserted nothing and cutting removed nothing. Copy, cut, paste and drop events are cancelled. The right-click menu is blocked. Ctrl+A outside the editor is blocked. Question text is unselectable.
- **Full screen:** leaving full screen (`exitFullscreen`) shows the blocking gate and the page behind it is `inert`. Returning closes the gate.
- **Tab switch (real):** a second tab brought to the front made the first report `hidden`. Chrome exited full screen by itself, the gate asked again, and the tab switch was stored as **one** record with a 2.6 s duration (no extra full-screen exit and no extra window blur).
- **Server records:** the full-screen exit was stored with a 2.4 s duration. Separate actions were recorded separately, and a key press plus a clipboard event within milliseconds counted once. The summary showed total time outside, severity and status.
- **Identity:** events naming another candidate were refused (400). Events for an unstarted assessment were refused (409). The candidate cannot read the log (404). The admin routes rejected a missing key (401).
- **Reload mid-attempt:** the gate returned, the timer was not reset, `SESSION_RESUMED` was recorded and the violation count did not change.
- **Existing features:** the timer counted down, question navigation and drafts survived, **Run code (real Judge0) passed the samples, Submit (real Judge0) scored 10/10**, finishing showed the result screen, released full screen and showed no integrity information. After finishing, the record was sealed and later events got 403.
- No console or page errors.

The first run of this suite found a genuine editor bug, now fixed: right after Tab, the next typed letter could land at the end of the text, because the indent was applied through React state and the caret was restored a frame later. The editor now inserts the indent with the browser's own text-insertion command (this also keeps native undo working). The suite passed 56 of 56 after the fix.

**Regression run: 34 of 34 checks passed** (with `DSA_PROCTOR_MAX_STRIKES=0`; the earlier UI suite, adapted to the consent and full-screen start): intro, timer, navigation, per-language drafts, Run, Submit, wrong answer (partial score), Java compile error, reload, finish, invalid link, mobile width without horizontal scroll, dark mode, automatic end at timer expiry, and no hidden test data in the network payloads.

### Not verified in a real browser (be aware)

- **Window focus loss while the tab stays visible (`WINDOW_BLUR`).** Headless Chrome cannot take OS focus away, so this was tested by overriding `document.hasFocus()` and dispatching the real `blur` and `focus` events (4 of 4 checks passed): one `WINDOW_BLUR` record with a 3.1 s duration (a focus loss must last 1 s to count), and a blur followed by `hidden` produced a single `TAB_SWITCH` with no extra blur. The merge logic is also covered by the unit tests, but the real browser path for this one event is **simulated**, not observed.
- **Firefox, Safari, Edge, macOS (Cmd shortcuts), mobile and touch devices** were not tested. Chrome on Windows only.
- The clipboard `copy`/`cut`/`paste`/`drop` events were checked with dispatched events (key-based blocking was checked with real key presses).
- **No test for the page being used with JavaScript or network blocked** (a limitation, see §7).

---

## 10. HR integration contract

What the HR dashboard (another developer's) needs to do; nothing here rebuilds it.

1. **Link an application to a record.** Store `inviteRefFor(token)` when the DSA invitation is created, or compute it from the token you already hold. It is the `:inviteRef` in every HR route.
2. **Replace the key guard** with the HR session and permission check, with tenant scoping (an HR user must only see their own company's candidates).
3. **Per-candidate panel** (on the existing Assessments page): call `/summary` for the status chip (`clean` / `warning` / `review` / `disqualified`), the counters (tab switches, full-screen exits, copy/paste attempts, context-menu and dev-tools attempts, total time outside), and `reasons[]`. Call `/events` for a timeline with `severity`, `at`, `durationMs`, `detail`.
4. **Review queue:** `/flagged` lists attempts needing review, worst first.
5. **Wording:** label the data "observations from the browser, not proof of misconduct". Offer the existing HR override with a reason (if the human reviewer disagrees with the flag). Do not auto-reject on `flagged`.
6. **Round engine:** if a result must be marked for review, use the status from `/summary`; do not let proctoring change the score (it never does in this module).
7. **Storage and deployment:** apply the migration in §6, bind `DSA_PROCTOR_STORE` to the Prisma store, set `DSA_ADMIN_API_KEY` only until the real guard exists, and decide the retention period.
