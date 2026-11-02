# M12 AI Screening Round (voice)

A shortlisted student opens a personal link from the shortlist email, talks to an AI interviewer for ~5-8 minutes,
and HR reads the transcript and structured notes in the HR dashboard. **Information only - never a score or a
hiring decision.**

## 1. The flow

```
apply (M09) -> resume screened (M10/M11, ats module) -> score >= job minimum (or HR shortlists)
   -> shortlist email queued AUTOMATICALLY (AUTO_SHORTLIST_EMAILS, needs a public screening link; else HR sends it)
   -> ats module creates screening_invites (SHA-256 of a random 32-byte token, valid 7 days) and emails
      ${AI_SCREENING_URL or CAREERS_SITE_URL/screening/{token}}
   -> student opens careers site /screening/<token>
        consent (stored in consents, purpose ai_voice_screening) + microphone
        loop: question spoken (TTS) -> student answers -> audio uploaded -> transcript saved -> next question
   -> COMPLETED -> structured notes extracted in the background (screening_results)
   -> HR: Shortlisted page -> candidate card -> "AI screening" -> transcript + notes + review status
```

The six steps (`apps/api/src/modules/screening/flow.ts`): **Introduction, Education, Background, Location (uses the
job's location), Availability (+ college NOC follow-up when relevant), Candidate questions** (answered only from the
published job information), then a closing message. At most 1 follow-up per question (2 in Availability), 3 candidate
questions, 18 answered turns, 15 minutes - all enforced by the API, not by the model.

## 2. Voice architecture

```
Browser (careers site)                API (NestJS)                         AI worker (FastAPI)          Gemini
MediaRecorder (webm/opus or mp4) --->  POST /public/screening/answer  ---> POST /v1/screening/turn
                                       token -> invite -> application        1. transcribe (audio ONLY) ---> LLM_MODEL
                                       seq / clientTurnId checks             2. decide follow-up (text) ---> LLM_MODEL
                                       saves the turn (transaction)  <---    (skipped when not allowed)
<audio> plays WAV            <------   GET /public/screening/speech  ---> POST /v1/screening/speak   ---> SCREENING_TTS_MODEL
                                       (in-memory cache by text)                                          (+ fallbacks)
                                       on completion (background)    ---> POST /v1/screening/extract ---> LLM_MODEL
```

- Speech-to-text + LLM + text-to-speech, all Gemini, through the worker's existing gateway (no new provider account).
- Provider boundary: `ai_worker/speech/provider.py` (`SpeechProvider`) and the existing `LLMProvider`. Another vendor
  plugs in there; the API, careers site and flow do not change.
- **Why transcription is a separate call**: measured during testing - when the transcription request also contained
  the question and earlier answers, Gemini turned 1.5 s of pure silence into a plausible made-up answer. The transcribe
  call now sees the audio alone; the decision call sees text only. The browser also refuses to send a recording whose
  loudest moment is near zero.
- Measured locally (India -> Gemini, free tier): spoken answer -> next question 4-12 s (two model calls); first-time
  speech of a question ~4-7 s, then instant from the cache. The page shows "Thinking about your answer..." meanwhile.

## 3. Security and privacy

- The link is a **bearer credential** for one application's screening. Only its SHA-256 is stored; it expires after
  7 days; it is sent to the API in a header (`x-screening-token`), never in API URLs. The page sets
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`. Anyone with the link can take
  the screening - the email is the only channel it is sent to.
- No id, email, phone or resume data in the page or URLs; the page shows the first name, job title and company only.
- Public endpoints: per-IP rate limits (`screening`, `screening-answer`), CSRF header, 6 MB / audio types only,
  `clientTurnId` + `seq` make re-sends idempotent; a request can never name another application.
- HR endpoints: login + `jobs.read` / `jobs.write`, company from the session; another company's ids are 404.
- **Raw audio is never stored** (sent to Gemini for transcription only). Stored: questions asked, transcripts, AI
  replies to candidate questions, structured notes, consent record, timestamps.
- Retention: screening rows are deleted with the application (`ON DELETE CASCADE`), including the student's own
  "delete my data" request on the careers site. No separate retention period yet - decide one before real use.
- Not a legal compliance statement (DPDP etc.) - have it reviewed before production use.

## 4. Run it locally

```bash
pnpm install
pnpm --filter api db:deploy            # applies 20261029075341_ai_screening (additive)
pnpm dev                               # API :4000, HR :3000, careers :3300
cd workers/ai-worker && uv sync && uv run python -m ai_worker   # :8000
```
`.env`: `GEMINI_API_KEY`, `LLM_PROVIDER=gemini`, `LLM_MODEL`, and the `SCREENING_*` settings in `.env.example`
(defaults are fine). `AI_SCREENING_URL` can stay empty: the link becomes `CAREERS_SITE_URL/screening/{token}`.
The microphone needs a secure page: `localhost` or https (the Cloudflare tunnel from `scripts/start-public.ps1`).

## 5. Tests

| Where | Command | Covers |
|---|---|---|
| API | `pnpm --filter api test` (`tests/screening/*`) | link valid/invalid/expired/other company, consent, saving per turn, follow-up limits, silence, duplicate uploads, out-of-sync, AI errors, completion + summary, end + resume, refresh, HR list/detail/review/authorization, statuses |
| AI worker | `uv run pytest tests/test_screening.py` | transcribe-then-decide, no context in transcription, follow-up rules, unknown stays unknown, candidate questions, errors, TTS fallback, WAV wrapping |
| Careers site | `pnpm --filter careers-site test` | recording format, mic errors, error -> retry mapping |

Verified by hand against real Gemini (local Docker DB, 29 Oct 2026): a full 9-turn screening through the careers-site
proxy (silence refused, follow-ups asked, stipend answered from the job form, COMPLETED, notes extracted), HR
endpoints with real sessions (owning company sees it, other company 404), and the page in real Chrome with a simulated
microphone (consent, speaking -> listening -> saved -> next question, end + refresh resumes, no token in console or
browser storage).

## 6. Temporary deployment (not done yet)

Nothing is deployed. A plan that fits the current code:

| Part | Suggested host | Notes |
|---|---|---|
| Database | **Neon** (existing, Singapore) | run `pnpm --filter api db:deploy` once (one person) |
| API (NestJS) | Render / Railway / Fly.io (Node 22, `pnpm --filter api build && node dist/main.js`) | needs `DATABASE_URL`, `AI_WORKER_URL`, `CORS_ORIGINS`, `HR_DASHBOARD_URL`, `CAREERS_SITE_URL`, mail + LinkedIn + `ENCRYPTION_KEY`, `NODE_ENV=production`, `COOKIE_SECURE=true`. Single instance (in-memory rate limits/cache). |
| AI worker (FastAPI) | Render / Railway / Fly.io (Python 3.12, `uv sync`, `uvicorn ai_worker.main:app --port $PORT`) | `GEMINI_API_KEY`, `LLM_*`, `SCREENING_*`. Not exposed publicly if the host supports private networking. |
| Careers site + HR dashboard (Next.js 15) | Vercel (simplest), or Cloudflare via OpenNext (needs checking: the careers site uses rewrites + middleware) | careers: `API_INTERNAL_URL` = API URL, `TRUSTED_CLIENT_IP_HEADER`; HR: `NEXT_PUBLIC_API_URL` |

Free tiers sleep after inactivity (first request 30-60 s), have request time limits (an answer takes up to ~35 s
worst case - check the host's limit), and **the Gemini free tier quota is small**: during testing `gemini-3.5-flash`
hit "exceeded your current quota" and TTS returned 429 after a few calls. For real students use a paid Gemini key
(costs are per audio second / token; a screening is ~10-14 model calls).

Before claiming a deployment works, check: health endpoints, worker reachable from the API, migration applied, a
shortlist email with the deployed (https, not localhost) link, the link opened on a phone on mobile data, a full
screening completed, rows in Neon, HR sees it, an expired/invalid link refused.

## 7. Known limitations

- Supported language: English prompts and voice; Gemini can transcribe other languages but the questions are English.
- iOS Safari before 18.4 records MP4/AAC; the worker sends it to Gemini as `audio/m4a` - not yet tested on a real iPhone.
- No barge-in / live streaming: answer, then press "Done answering" (auto-stops at 3 minutes).
- HR cannot resend a screening link after the shortlist email was sent (ats module rule).
- Rate limiter and speech cache are per API instance (in memory).
