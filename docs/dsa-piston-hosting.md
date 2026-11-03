# DSA assessment: hosting with Piston

How the DSA coding assessment runs on **one hosting PC**, what that PC needs, and how to start, test and troubleshoot it.
Candidates and teammates install **nothing**: no Piston, Docker, Python, Java or C++. A candidate needs a browser and the personal link.

---

## 1. Architecture

```
Candidate's browser ──HTTPS──▶ Cloudflare tunnel / your domain ──▶ candidate-app (Next.js, :3001)
                                                                       │  only /api/v1/dsa/* is forwarded
                                                                       ▼
                                                              HireFlow API (NestJS, :4100)
                                                                       │  server-side only, 127.0.0.1
                                                                       ▼
                                                        Piston (Docker, 127.0.0.1:2000) ── sandbox per run
```

- **All code runs on the hosting PC.** The browser sends the source to the API; the API wraps it, runs it in Piston and returns verdicts. Python, Java and C++ toolchains exist only inside the Piston container.
- **Piston is never public.** It has no login, so it is published on `127.0.0.1` only and sits on Docker's default network, not on HireFlow's (`hireflow_default`), so it cannot reach Postgres or Redis. Only the API talks to it.
- **The public site forwards `/api/v1/dsa/*` and nothing else.** Probed through the public URL: `/api/v2/runtimes` (Piston), `/api/v1/dsa-admin/*`, `/api/v1/health` and `/api/v1/auth/me` all answer 404.
- **Hidden test cases never leave the server.** Verified again on this setup (network payloads scanned in the browser tests).
- **Execution is bounded**: a global concurrency limiter (default 3 runs at once), a per-submission cap (2), a queue with a timeout and a maximum length, per-run CPU, wall-time and memory limits, no network inside the sandbox, capped output size.

The execution engine sits behind one interface (`CodeRunner`, `execution/code-runner.ts`). `PistonRunner` is the only implementation. Swapping the engine does not touch the questions, timer, scoring, proctoring or UI.

---

## 2. Hosting requirements

| Item | Minimum | Recommended | Notes |
|---|---|---|---|
| OS | Windows 11 / 10 with Docker Desktop (WSL2 backend), or any Linux with Docker | Linux server | Piston needs **pure cgroup v2**. Docker Desktop's WSL2 VM provides it (verified here). |
| RAM | 8 GB | 16 GB | Docker's VM defaults to ~half of host RAM (3.7 GiB here). Java and C++ compiles need hundreds of MB each. On this 7.7 GB PC only 0.6 to 0.7 GB was free while testing, so close other heavy apps during an assessment. |
| CPU | 4 threads | 8 threads | Measured on an i3-1215U (8 threads). Compile time dominates (see §7). |
| Disk | 10 GB free | 20 GB | Piston image ~1.4 GB; Python, Java and gcc packages live in the Docker volume `hireflow_piston_data`. |
| Network | Outbound internet for the tunnel; first run downloads the image and packages | Stable wired connection | Inbound ports are **not** opened; the tunnel connects outwards. |
| Power | Never sleeps during an assessment | | See below. |
| Docker | Docker Desktop with "Start Docker Desktop when you sign in" on | | The Piston container has `--restart unless-stopped`. |

**Power settings (Windows).** Settings → System → Power → Screen and sleep: set *When plugged in, put my device to sleep* to **Never**. A sleeping PC drops the tunnel and every candidate's session. Keep the laptop plugged in and the lid action on *Do nothing*.

The PC must stay on, awake and online from the first candidate's start until the last candidate's deadline.

---

## 3. Startup procedure (every time, in this order)

Run from the repository root in PowerShell.

1. **Piston.** Idempotent: starts Docker Desktop if needed, creates or starts the container, checks that it is localhost-only and off the HireFlow network, installs missing languages, then runs a real Python, Java and C++ program in the sandbox. It refuses to continue if any check fails.

   ```powershell
   powershell -ExecutionPolicy Bypass -File infra\piston\start-piston.ps1
   ```

   First run pulls ~1.4 GB and installs three packages (several minutes). Later runs take seconds. `-Recreate` rebuilds the container from `infra\piston\piston.env` (packages are kept in the volume). `-SkipSmokeTest` skips the three test programs.

2. **API** (build once after code changes with `pnpm --filter api build`):

   ```powershell
   $env:API_PORT = '4100'
   $env:NODE_ENV = 'production'
   $env:DSA_DEMO_TOKENS = '<token1>:60,<token2>:60'     # until real invitations are wired in; each token >= 16 chars
   $env:DSA_ALLOW_DEMO_TOKENS = 'on'                    # required with NODE_ENV=production
   $env:DSA_ADMIN_API_KEY = '<long random string>'      # proctoring admin routes stay closed without it
   node apps\api\dist\main.js
   ```

3. **Candidate app.** The API address and the `NEXT_PUBLIC_*` values are baked in at **build** time, so build with them set:

   ```powershell
   $env:NEXT_PUBLIC_API_URL = '/api/v1'
   $env:API_INTERNAL_URL    = 'http://127.0.0.1:4100/api/v1'
   pnpm --filter candidate-app build
   pnpm --filter candidate-app exec next start -p 3001
   ```

4. **Public address.** Expose only the candidate app:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:3001
   ```

   Copy the printed `https://….trycloudflare.com` URL. Links are `https://<that-host>/dsa/<token>`.

   A quick tunnel gets a **new URL every time it restarts**, so links already sent stop working. For links that must keep working use a named Cloudflare tunnel on a domain you own, or ngrok with a static domain.

5. **Check before sending links** (§5).

Shutdown: stop the tunnel first (candidates see an error page instead of a half-working one), then wait until no candidate is mid-assessment, then the API and candidate app. Sessions are **in memory**: restarting the API loses every running assessment and every proctoring record.

---

## 4. Settings reference

### Backend (`apps/api`, environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PISTON_URL` | `http://127.0.0.1:2000` | Where the API reaches Piston. Keep it on localhost. |
| `DSA_RUNNER_CONCURRENCY` | `3` | Runs executing at once across all candidates. Piston itself allows 4. |
| `DSA_RUNNER_PER_SUBMISSION` | `2` | Test cases of one submission run in parallel. |
| `DSA_RUNNER_QUEUE_TIMEOUT_MS` | `60000` | A run waits at most this long for a free slot, then is refused ("busy"), never faked as passed. |
| `DSA_RUNNER_MAX_QUEUE` | `60` | Waiting runs beyond this are refused immediately. |
| `DSA_RUNNER_REQUEST_TIMEOUT_MS` | `60000` | Timeout for one Piston call. |
| `DSA_RUN_TIMEOUT_MS` / `DSA_RUN_CPU_MS` | `5000` / `4000` | Per test: wall and CPU time (Python, C++). |
| `DSA_RUN_MEMORY_MB` | `256` | Per test memory (Python, C++). |
| `DSA_COMPILE_TIMEOUT_MS` / `DSA_COMPILE_MEMORY_MB` | `10000` / `512` | C++ compile limits. |
| `DSA_JAVA_RUN_TIMEOUT_MS` / `DSA_JAVA_RUN_CPU_MS` / `DSA_JAVA_RUN_MEMORY_MB` | `8000` / `7000` / `512` | Java compiles inside its run (single-file source mode), so these cover javac too. |
| `DSA_DEMO_TOKENS` | unset | `token:minutes,…` replaces the two built-in demo tokens. Tokens shorter than 16 characters are ignored. |
| `DSA_ALLOW_DEMO_TOKENS` | off | Demo tokens are refused when `NODE_ENV=production` unless this is `on`. |
| `DSA_ADMIN_API_KEY` | unset | Key for `x-dsa-admin-key`. Unset = admin routes closed. |
| `DSA_PROCTOR_MAX_STRIKES` | `2` | Suspicious actions allowed before the third ends the assessment. |

Per-request limits can only be **at or below** the ceilings in `infra\piston\piston.env`; Piston rejects higher values.

### Piston (`infra\piston\piston.env`, applied with `-Recreate`)

Network disabled, output capped at 64 KiB per stream, 4 concurrent jobs, 64 processes, 512 open files, run limit 8 s wall/CPU and 256 MiB (Java override: 128 processes, 512 MiB run, 768 MiB compile), compile limit 15 s and 512 MiB. The image is pinned by digest in `start-piston.ps1`, so an upstream change cannot alter the sandbox unnoticed. To upgrade, change the digest, run `-Recreate` and re-run the live suite (§6).

### Candidate app

`next.config.ts` forwards only `/api/v1/dsa/*`, raises the proxy timeout from Next's 30 s default to 240 s (a submit can queue behind others), and sets no-referrer, no-store and noindex headers on `/dsa/*` because the URL contains the candidate's token.

---

## 5. Remote-access test (do this before real students)

A test from `localhost` proves nothing about the network path. Use a second device on **another network** (a phone on mobile data is ideal).

1. Start everything (§3) and note the public URL and a token.
2. On the other device open `https://<public-host>/dsa/<token>`. You should see the start screen with the 60-minute timer and **no** question text yet.
3. Tick the notice, press *Start in full screen*. Questions, timer and tabs appear.
4. For each of Python, Java and C++: paste a correct solution to *Two Sum*, press **Run** (samples pass), then **Submit** (all tests pass, hidden tests listed without input or output).
5. Make a deliberate mistake (missing semicolon): a compile error shows with the line mapped to your code (`solution:N`).
6. Press PrintScreen: "Warning 1 of 2" appears. Leave full screen: the return-to-full-screen gate appears.
7. Finish. The result screen shows the score and nothing about proctoring.
8. From the same device confirm these are **not** reachable: `https://<public-host>/api/v2/runtimes`, `/api/v1/health`, `/api/v1/dsa-admin/proctoring/flagged` (all must be 404).
9. On the hosting PC: `docker port hireflow-piston` must print only `127.0.0.1:2000`.

What was verified from the hosting PC itself, through the real Cloudflare URL (a truly separate network was **not** possible to test from here, so step 2 to 8 on a second device is still yours to do): the full journey in Chrome (start screen, consent, full screen, Run, Submit 10/10, proctoring warning, finish, result), 11 of 11 checks, every API call 200, no console errors, and the exposure probes in step 8.

---

## 6. Test results on this PC (2026-11-02)

| Check | Result |
|---|---|
| Live suite `dsa-piston.integration.test.ts` (3 questions × Python/Java/C++: correct, wrong, Run; compile error, runtime error, infinite loop per language; debug prints; score aggregation) | **38 / 38 passed** (143 s) |
| Piston runner unit tests (`dsa-piston-runner.test.ts`) | 21 passed |
| Browser regression of the assessment UI through the production candidate app, code running on Piston | **34 / 34** |
| Browser regression of proctoring (strike limit 0), Run and Submit on Piston | **56 / 56** |
| Public-URL journey through Cloudflare | **11 / 11** |
| Sandbox limits | Infinite loop ends as `time_limit`; runtime error and compile error are reported per test; no network inside runs |
| `start-piston.ps1` | Run twice (idempotent), `-Recreate` (packages kept), and after a plain `docker restart`: API back in ~2 s, Python run returned the right answer |

Full-suite counts are in `docs/dsa-integration-notes.md` §7.

### Capacity (load test `dsa-piston-load.test.ts`, opt-in)

All runs correct, none refused, with the defaults above (concurrency 3):

| Simultaneous submissions | Result |
|---|---|
| 6, 12 | all correct |
| 10 Java, 10 C++ | all correct |
| 20 mixed languages | all correct |
| 20 C++ | all correct; slowest ≈ 113 s |

Single candidate, one full Submit (all test cases): Python ≈ 0.5 s, Java ≈ 4 to 5 s, C++ ≈ 9 to 12 s. **C++ is slow because each test case compiles again.**

Planning rule of thumb for this hardware: a class of about 20 students is fine if they do not all press Submit on C++ in the same second; a burst of 20 C++ submits makes the last one wait close to two minutes. Cloudflare's edge cuts a request off at about 100 s on its default plan (documented behaviour, not verified here), so an extreme burst could show an error while the result is still being computed. Mitigations in order of effort: stagger start times; raise `DSA_RUNNER_CONCURRENCY` to 4 on a bigger machine; run all test cases of a submission in one compile (code change, not done); make Submit asynchronous with polling (code change, not done).

---

## 7. Known limits

- **Sessions and proctoring data are in memory.** An API restart ends every running assessment. A Prisma-backed store is designed (`SessionStore` interface) but not applied.
- **Only 3 mock questions** and per-problem-shape harnesses. HR question bank integration, real invitation tokens, the "selected" email and the pass rule (e.g. 25 of 60) need changes in teammate-owned modules (round-engine, rounds-config, notifications). Not done.
- **Teammates cannot reach a localhost-only Piston.** They test through the hosted URL, or run their own copy with `start-piston.ps1`. A shared runner for several developers needs a private network or authenticated reverse proxy in front of Piston; **never** publish port 2000 as is.
- **Quick-tunnel URLs change on restart.** See §3 step 4.
- **Memory headroom on this PC is thin.** Java and C++ compiles at the same time as a browser, an IDE and other containers can fail with out-of-memory. A failed run is reported as an error, never as a pass.
- **Piston has no authentication.** Its safety depends entirely on the `127.0.0.1` binding. The start script verifies it every time; do not change the `-p` mapping.

---

## 8. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| API answers 503 `CODE_RUNNER_UNAVAILABLE` | Piston is down or unreachable. `docker ps`, then rerun `start-piston.ps1`. Check `curl http://127.0.0.1:2000/api/v2/runtimes`. |
| API answers 503 `CODE_RUNNER_BUSY` | Queue full, or a run waited over `DSA_RUNNER_QUEUE_TIMEOUT_MS`. Fewer simultaneous submits, or raise `DSA_RUNNER_CONCURRENCY` if RAM allows. |
| API answers 429 `BUSY` | That candidate's previous run is still executing (one at a time per candidate). Wait for it. |
| Java or C++ runs end with exit 137 | Out of memory. Close other programs, or raise Docker Desktop's memory (Settings → Resources, or `.wslconfig`). |
| Start script says the port is published beyond localhost | Run with `-Recreate`. Do not edit the `-p` mapping. |
| Start script says Piston is on the HireFlow network | Run with `-Recreate`; do not attach it to `hireflow_default`. |
| Public link shows an old or dead page after a restart | The quick-tunnel URL changed. Send the new one, or move to a named tunnel. |
| Page loads, API calls fail with 500 after about 30 s | The candidate app was built without the proxy setting, or `API_INTERNAL_URL` was wrong at build time. Rebuild with §3 step 3. |
| Friendly "invalid link" page for a token that should work | The API was restarted without the same `DSA_DEMO_TOKENS`, or `NODE_ENV=production` without `DSA_ALLOW_DEMO_TOKENS=on`. |
| Admin proctoring routes answer 404 | Closed by design: `DSA_ADMIN_API_KEY` is not set on the API, or the `x-dsa-admin-key` header differs. |
| Docker Desktop will not start after a reboot | Start it manually once, then rerun the start script. |
