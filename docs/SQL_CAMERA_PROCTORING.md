# AI camera monitoring (SQL and DSA rounds)

On SQL and DSA rounds, the coding page watches the webcam to notice suspicious patterns: repeated or long looks away
from the screen, the face leaving the camera's view, more than one face in view, very frequent head turning, and the
camera turning off. It extends the existing proctoring (full screen, tabs, clipboard, screenshots). The SQL and DSA
pages look the same; only a camera check before the start and a small self-view are added. `DSA_PROCTOR_CAMERA`:
`all` (default) watches SQL and DSA rounds, `sql` only SQL rounds (DSA rounds camera-free), `off` none. It replaces
the earlier face-count-only webcam check on DSA rounds; its events (`CAMERA_OFF`, `NO_FACE`, `MULTIPLE_FACES`) are
still accepted from older pages and counted in the same camera totals.

**What it is not:** a webcam cannot see a second laptop or phone outside its view. A repeated or long look away is a
**suspicious pattern for HR to review, never proof of cheating**. The wording to candidates and HR says so.

## How it works

1. **In the candidate's browser.** MediaPipe Face Landmarker (`@mediapipe/tasks-vision` 1.1.1, pinned) runs locally
   about 5 times a second, or 2 times on slow computers. Each frame is reduced to a few numbers: 4 face points and the
   eye blendshape scores. The video, images and face landmarks never leave the computer and are never stored.
2. **Gaze = head pose + eyes.**
   - Head turn is the nose's offset from the eyes' middle, in eye widths. Head tilt is the nose's height between the
     eyes and the chin.
   - The eyes are judged by the blendshapes `eyeLookOut/In/Down/Up`, but only while the head is straight. Blinks are
     ignored.
   - Everything is compared with the candidate's **own resting position**, learnt in the first seconds of the
     attempt. This reduces the effect of camera placement, posture and glasses.
3. **Grouping: a single glance never counts.** These rules live in contracts `camera-proctoring.ts` and are shared and
   unit-tested.

| Alert | When (defaults) |
|---|---|
| Looked away (left / right / down / up) | 4 looks of 1.5 s or more in the same direction within 60 s, **or** one look of 6 s or more. "Down" is noted as "possible phone or notes". |
| Face not visible | No face for 5 s or more ("poor lighting" when the frames are dark). |
| More than one face | 2 faces for 2 s or more (shorter flickers are ignored). |
| Frequent head movement | 10 large turns within 30 s. |
| Camera stopped | The camera was turned off, unplugged or its permission withdrawn. The page then blocks until the camera is back on. |

   - Looks shorter than 1.5 s are glances; returning for less than 0.6 s is part of the same look.
   - A continuing behaviour is **one** alert, followed by a 30 s cool-down. The server adds a 20 s safety net.
4. **Warnings: the existing policy.** Each alert is one violation, just like leaving full screen. Warning 1, warning
   2, then the third violation ends the attempt, which is graded with what was submitted.
   - Set `DSA_PROCTOR_CAMERA_STRIKES=off` to keep camera alerts for review only, without warnings.
   - Either way, any camera alert marks the attempt **"Needs a look"** for HR.
5. **HR.** Assessments → student → the round's *Monitoring record* shows:
   - the camera counts;
   - each event with its time, an "AI camera" label, what was seen (e.g. `left: 4 looks in 60 s`), duration,
     confidence and the warning it used (or "ended the attempt").

   HR decides; nothing is concluded automatically beyond the existing warning limit.

Stored per event, in the existing proctoring record (`dsa_proctor_sessions`, so no migration is needed): event type,
time, duration, confidence, detail, plus the invitation (candidate + round) and the warning number computed in time
order.

## Setup

- `pnpm --filter candidate-app dev` / `build` first runs `scripts/prepare-face-model.mjs`. It copies the WASM runtime
  from the installed package and downloads the face model (3.7 MB) once, checking it against a pinned SHA-256. Both
  are served by the candidate app itself from `public/mediapipe` (git-ignored), never from a CDN.
- The candidate page's `Permissions-Policy` allows `camera=(self)`. The camera needs https (or localhost).
- Env (`.env.example`): `DSA_PROCTOR_CAMERA` (`sql` | `all` | `off`), `DSA_PROCTOR_CAMERA_STRIKES` (`on` | `off`),
  `DSA_PROCTOR_CAMERA_COOLDOWN_MS`. The thresholds are in `CAMERA_RULES_DEFAULTS`.
- Candidates must allow the camera before Start. They get clear messages when it is blocked, missing, in use by
  another app, or when this browser cannot run the check.

## Tests

- `packages/contracts/tests/camera-proctoring.test.ts` uses synthetic face measurements at 5 frames per second and
  covers:
  - looking at the screen, single and short glances (none of these alert);
  - repeated left and right looks;
  - looking down with the head or only with the eyes, and a long look (another screen);
  - frequent head movement, leaving the view, two faces (and flicker that should not alert), darkness;
  - an off-centre camera (calibration), blinks, the cool-down, the camera stopping, and configurable thresholds.
- `apps/api/tests/sql/sql-camera-proctoring.test.ts` covers:
  - SQL and DSA rounds camera-monitored by default, DSA rounds camera-free with `DSA_PROCTOR_CAMERA=sql`;
  - consent and camera required to start;
  - warning 1 (camera), warning 2 (full screen), and the 3rd (two faces) ending and grading the attempt;
  - the cool-down, the HR record (time, duration, confidence, warning number, review flag);
  - review-only mode, camera alerts refused for non-camera attempts, input bounds, and the email wording.

**Not tested here:** the real model on real faces. This environment has no webcam or browser automation, so lighting,
glasses, head positions and camera angles still need trying on real laptops. Start with a few staff runs before
using it in placements, and tune `CAMERA_RULES_DEFAULTS` if needed.

## Known limitations

- It cannot detect devices outside the camera's view, sounds, or another person who stays out of view.
- Eye-direction scores are less reliable with strong glasses glare, very low light, or a camera far off to one side.
  The calibration helps, but it doesn't remove these problems.
- People who naturally look down while thinking can produce "down" alerts. The 4-looks-in-60-s and 6-second rules
  are deliberately conservative; HR should review before deciding.
- Browsers without WebAssembly / WebGL, or very slow computers, may fail the camera check. The candidate then cannot
  start a camera-monitored round in that browser and is told to use a recent Chrome or Edge.
