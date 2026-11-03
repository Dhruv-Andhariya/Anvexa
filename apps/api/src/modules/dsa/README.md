# dsa

| | |
|---|---|
| **Owner** | DSA assessment developer |
| **Release** | v0.3 (wired to round-engine: a DSA round of the job's selection process) |

The candidate's coding test: the problem bank (with hidden tests), the server-side timer, code execution on Piston
(see `docs/dsa-piston-hosting.md`), scoring and browser proctoring. A DSA **round** is configured by HR in the rounds
editor and run by the round engine: invitation email, result, outcome email. Guide: `docs/DSA_ASSESSMENT_ROUND.md`.

## How it is wired
| Piece | Real (default) | Demo (`DSA_DEMO_MODE=on`) |
|---|---|---|
| Invitation / link token | `RoundInvitationResolver` -> `RoundEngineService.openCodingRound` | `DemoInvitationResolver` (`DSA_DEMO_TOKENS`) |
| Questions | `BankQuestionRepository`: the round's bank problems under HR's question ids and marks | the whole bank |
| Session (attempt, progress, result) | `EngineSessionStore` -> the engine's `round_attempts` row | in memory |
| Proctoring record | `PrismaProctorStore` -> `dsa_proctor_sessions` | in memory |
| Code runner | `PistonRunner` (`CODE_RUNNER`) | same |

Routes: `/api/v1/dsa/:token/*` (candidate, public, token = credential), `/api/v1/dsa-hr/applications/:id/proctoring`
(HR session, `jobs.read`, own company only), `/api/v1/dsa-admin/proctoring/*` (service key, closed unless
`DSA_ADMIN_API_KEY` is set). Off with `FEATURE_DSA=off`.

## Rules for this folder
- Talks to the round engine ONLY through `round-engine/index.ts` (`RoundEngineService`), never its store or tables.
- Hidden test cases live only in `questions/` and are never serialised to a client (`toPublicProgress` and
  `toPublicQuestion` are whitelists; the stored best source code never leaves the server).
- The bank list HR sees is `DSA_BANK` in `packages/contracts`; `tests/dsa-bank-sync.test.ts` keeps it in step with
  `questions/mock-questions.data.ts`. Add a problem in both, plus a harness if it has a new function shape.
- Full notes: `docs/dsa-integration-notes.md`, `docs/dsa-proctoring-implementation.md`.
