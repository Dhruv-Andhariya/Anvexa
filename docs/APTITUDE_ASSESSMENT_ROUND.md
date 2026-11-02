# M13 Aptitude & English Literacy round (online test rounds)

After the AI voice screening, a student gets an email with a personal link, takes a timed, webcam-monitored
multiple-choice test on the careers site, and is graded on the server against the pass mark HR set. A pass moves the
student to the next round automatically; a fail sends a polite rejection. HR sees the score, answers, time taken and
the proctoring log on the existing **Assessments** page.

Module: [`apps/api/src/modules/round-engine`](../apps/api/src/modules/round-engine/README.md). Builds on M05
([ASSESSMENT_ROUNDS.md](ASSESSMENT_ROUNDS.md)): the rounds, questions and pass rules are the ones HR saves on the
Publish page, and results go through the existing assessments module. Nothing is configured twice.

## 1. The flow

```
HR: Publish dialog -> round 1 "Aptitude & English Literacy" (type Aptitude), MCQ / true-false questions, time limit,
    pass rule (e.g. 60% of marks) -> rounds COMPLETE -> publish            (M05, rounds-config - unchanged)
student applies -> resume screened (ATS) -> shortlisted -> AI voice screening COMPLETED      (M09 - M12, unchanged)
   -> round-engine worker (every ROUND_ENGINE_POLL_MS) finds the completed screening, the job's round 1 is an online
      test -> round_invites row QUEUED                                          (AUTO_ROUND_INVITES=on)
   -> invitation email: company, job, round, questions, duration, HR's instructions, link, link expiry
      link = CAREERS_SITE_URL/assessment/<token>   (only its SHA-256 is stored; held while the link is localhost)
   -> student: landing page (facts, instructions, monitoring notice, consent) -> system check (camera preview,
      full screen, connection) -> Start -> exam (server clock, autosave) -> Submit / time runs out
   -> API grades through AssessmentsService.record() (pass / fail ONLY in assessments/grading.ts) -> round_results
   -> next step, exactly once:
        failed                                -> rejection email, journey ends
        passed, next round is an online test  -> that round's invitation (same flow again)
        passed, next round is run by HR       -> "cleared - HR will contact you about <next round>" email
        passed, no further round              -> "cleared all rounds - HR will contact you" email
HR: Assessments -> job -> student -> round card: score, pass mark, answers (existing) + online test panel (new):
    invitation status, time taken, answered, proctoring log, outcome email, "Withdraw link", "Send again"
```

**Which rounds run online:** a score-based pass rule (correct answers, marks or percentage) and only multiple-choice
or true/false questions. That is what an Aptitude & English Literacy round is in the M05 editor (type Aptitude allows
MCQ and true/false; a Custom round with only MCQ also works). A round with only **coding** questions and a score rule
runs on the DSA coding page instead (same invitation flow, link `DSA_SITE_URL/dsa/<token>`; see
[dsa-integration-notes.md](dsa-integration-notes.md)). Descriptive and interview rounds are run by HR.

## 2. What the student sees (careers site `/assessment/[token]`)

| Screen | Content |
|---|---|
| Landing | Company, job, round name; duration, number of questions, maximum marks, link expiry; HR's instructions (round description); how the timer and autosave work; **monitoring notice**; consent checkbox |
| System check | Live camera preview, checks for browser / camera / full screen / connection, clear messages for blocked, missing or busy cameras. With `ASSESSMENT_REQUIRE_CAMERA=on` the test cannot start without a camera |
| Exam | Sticky bar: round, candidate, job, save status, countdown (red in the last 5 minutes), camera thumbnail. Question with options (radio, or checkboxes for "select all that apply"), Previous / Mark for review / Clear / Save & next. Palette with answered / not answered / marked colours and counts. Submit with a confirmation that shows unanswered and marked counts |
| Done | "Submitted" or "Time is up - your saved answers were submitted"; the result comes by email |

The page never shows the correct answers, the pass mark or the score.

## 3. Rules the server enforces

- **The link** is the only credential: 32 random bytes, only the SHA-256 is stored, sent in a header
  (`x-assessment-token`), never in API URLs; `Referrer-Policy: no-referrer`, `no-store`, `noindex` on the page. It
  works for `ASSESSMENT_LINK_DAYS` (7) from the send time, for one application and one round. Expired -> 410,
  withdrawn by HR -> 410, unknown -> 404, a link whose application / job / round does not match -> refused.
- **One attempt** per student per round (unique keys). Start again / refresh / second tab = the same attempt.
- **The clock is the server's**: `deadline = start + time limit` (no time limit = until the link expires). The page
  counts down by the server's time (device clock errors do not matter). Saves after the deadline (+30 s for slow
  networks) are refused; the saved answers are submitted (`TIMED_OUT`) - by the next page request or by the worker.
- **Re-entry policy:** closing the page, refreshing or losing the connection does NOT pause or reset the test. The
  student opens the same link again, passes the camera check, and continues with the saved answers and the remaining
  time. Answers given offline are kept on the device and sent when the connection is back (newest revision wins).
- **Answers** are checked against the round (question exists, option exists, one choice for single-answer questions).
  Autosaves carry a revision; an older save never overwrites a newer one. Submitting twice is harmless.
- **The browser never sends** a score, a pass mark, a deadline, a company / job / candidate id or a pass / fail.
- **Questions and pass rules are frozen** when the first student starts (`lockForAttempts`); HR's editor is then
  read-only (409 `ROUNDS_LOCKED`). Every result is judged against what the student saw.
- **Next step exactly once:** `progressed_at` is claimed with a conditional update, invites and outcome emails have
  unique keys, emails are claimed with `FOR UPDATE SKIP LOCKED`. Safe with retries and several API processes. If the
  process stops between grading and the next step, the worker finishes it.

## 4. Webcam monitoring and privacy

- The camera is a **preview for the student only**. No video or image is recorded, uploaded or stored.
- Recorded: **events** with time - `ASSESSMENT_STARTED / SUBMITTED / TIMED_OUT` (server), `CAMERA_STARTED`,
  `CAMERA_STOPPED` (track ended), `CAMERA_PERMISSION_REVOKED` (where the browser reports it), `TAB_SWITCH` (page
  hidden), `FULLSCREEN_EXIT`, `CONNECTION_LOST`. WARNING severity for camera / tab / full-screen events. At most 500 per
  attempt; the browser's time is only used inside the attempt's window.
- The student is told before starting (landing page + email) and must tick consent (`consent_version` stored).
- **Events never decide a result.** Grading uses the answers only. HR sees the log labelled as observations ("not
  proof of cheating") and can override a result with a reason (existing M05 override, audited).
- If the camera stops during a required-camera test, the page asks the student to turn it back on (the timer keeps
  running) and records the event - it does not end the test.
- Retention: everything is deleted with the application (`ON DELETE CASCADE`, including the student's own "delete my
  data"). No separate retention period yet - decide one before real use. Not a legal compliance statement (DPDP etc.).

## 5. Emails

| When | Email | Contains |
|---|---|---|
| AI screening completed / previous online round passed | Invitation | company, job, round, question count, duration, HR's instructions, personal link, expiry, monitoring notice |
| Round failed | Rejection | polite rejection; no score |
| Passed, next round run by HR | Cleared | next round's name; HR will contact them |
| Passed the last round | Cleared all | HR will contact them about the final decision |

Sent in the background through the same mailer as the other emails (Gmail or SMTP). Temporary errors are retried
after 1, 5, 15 minutes; then FAILED (HR can "Send the invitation again" - with a new link; the failed one never
works). An invitation waits (no attempt used) while the link would be `localhost`.

## 6. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ASSESSMENT_URL` | empty | Assessment page URL with `{token}`. Empty = `${CAREERS_SITE_URL}/assessment/{token}` |
| `ASSESSMENT_LINK_DAYS` | 7 | Link validity from the send time |
| `ASSESSMENT_REQUIRE_CAMERA` | on | Webcam required to start (preview only) |
| `AUTO_ROUND_INVITES` | on | Invite automatically after a completed AI screening |
| `ROUND_ENGINE_PROCESSING` | on | Background loop (always off in tests) |
| `ROUND_ENGINE_POLL_MS` | 5000 | Loop interval |
| `ROUND_ALLOW_LOCAL_LINKS` | off | Local Mailpit testing only: also email localhost links |
| `FEATURE_ROUND_ENGINE` | on | `off` = every route answers 404 `FEATURE_DISABLED` |
| `PUBLIC_RATE_LIMITS` | `assessment=20000` per IP per hour | Raise for a big campus drive on one Wi-Fi |

Careers site: no new variables (it proxies `/api/v1/public/*` to `API_INTERNAL_URL` as before).

## 7. Run it locally

```bash
pnpm install                    # also regenerates the Prisma client
pnpm --filter api db:deploy     # applies 20261030120000_round_engine (additive: 4 new tables)
pnpm dev                        # API :4000, HR :3000, careers :3300
```
The camera needs a secure page: `localhost` works on your own machine; for a phone use the Cloudflare tunnel
(`scripts/start-public.ps1`). With a `localhost` link invitations wait; for a local email test set
`ROUND_ALLOW_LOCAL_LINKS=on` and use Mailpit.

## 8. Deployment (temporary Cloudflare, later production)

Nothing in the code holds a URL: every link comes from `ASSESSMENT_URL` / `CAREERS_SITE_URL`, so moving from the
temporary tunnel to a real domain is an `.env` change.

1. **Database:** `pnpm --filter api db:deploy` once against the target database (Neon).
2. **Careers site (assessment page):** either the existing Cloudflare quick tunnel (`scripts/start-public.ps1` writes
   the `https://<words>.trycloudflare.com` URL into `CAREERS_SITE_URL`), or a deployment (Vercel, or Cloudflare via
   OpenNext - check that it supports the `next.config.ts` rewrites and headers). It must be **https** (camera).
   Set `API_INTERNAL_URL` to the API and `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip` behind Cloudflare.
3. **API:** set `CAREERS_SITE_URL` (or `ASSESSMENT_URL`) to the careers site's public https URL, `CORS_ORIGINS` to the
   HR dashboard origin, `NODE_ENV=production`, `COOKIE_SECURE=true`. In production a localhost link is refused.
   Run **one** API instance (in-memory rate limits) - and only one API per database: a second API with another
   `CAREERS_SITE_URL` would send invitations with its own (possibly dead) link.
4. **Check:** health endpoints; an invitation email whose link is the https URL; the link opened on a phone on
   mobile data; camera prompt; a full test submitted; result on the HR Assessments page; the outcome email.

A quick tunnel gets a **new URL at every restart**: links already emailed then stop working. Use a named tunnel or a
deployment before inviting real students.

## 9. Tests

| Where | Command | Covers |
|---|---|---|
| API | `pnpm --filter api test` (`tests/round-engine/*`) | valid / invalid / expired / withdrawn links, other application / job / company, consent, published questions without answers, duration and deadline, autosave + stale revisions, invalid answers, scoring incl. "select all", threshold (exactly at the pass mark), PASS -> next invite / HR email / cleared-all, FAIL -> rejection, unanswered = wrong, duplicate submit, duplicate email prevention, time-out (request + worker), camera / tab events + severity + cap + clock bounds, events never change results, HR view + isolation, revoke / resend, config locked at start, AI screening -> invitation, held localhost link, failed email, interrupted next step, link building, email injection |
| Careers site | `pnpm --filter careers-site test` (`tests/assessment.test.ts`) | answer selection, mark for review, palette counts, server-clock timer, error mapping, camera errors |
| Everything | `pnpm check` | build, lint, typecheck, tests |

## 10. Known limitations

- No **sections**, **negative marking** or **per-job camera setting** in the M05 round configuration, so none here:
  questions are shown in HR's order; unanswered = 0 marks; the camera rule is the server setting. Adding them means
  extending the M05 editor and schema first.
- No central orchestrator / event bus yet (M29 / M30): this module queues the next step itself (idempotently).
- An HR override made **after** the outcome email does not send a new email or invitation.
- Tab switches inside a split screen or a second monitor cannot be detected by any web page; camera "presence" is not
  analysed (no face detection) - by design, no video processing.
- iOS Safari has no full-screen API for pages: full screen is skipped there (shown as optional in the check).
- Rate limits in memory (one API instance).
