# docs

| | |
|---|---|
| **Owner** | Shared |
| **Doc modules** | - |
| **Release** | - |

Project documentation. Update when a module, event or version changes.

| Document | What it covers |
|---|---|
| [GROUP_DISCUSSION_ROUND.md](GROUP_DISCUSSION_ROUND.md) | M18 AI group discussion: pool after the previous round, groups / time slots / topics, LiveKit room, AI moderator, evaluation, HR live dashboard (built in phases) |
| [APTITUDE_ASSESSMENT_ROUND.md](APTITUDE_ASSESSMENT_ROUND.md) | M13 online test rounds (Aptitude & English Literacy): invitation after AI screening, timed webcam-monitored test, server grading, next round / emails, HR view, deployment |
| [DSA_ASSESSMENT_ROUND.md](DSA_ASSESSMENT_ROUND.md) | DSA coding round: HR setup (problem picker), invitation after AI screening, coding page, scoring, cleared / rejection emails, HR review, operations |
| [dsa-piston-hosting.md](dsa-piston-hosting.md) | Code execution on the hosting PC with Piston: requirements, startup, limits, capacity, remote test, troubleshooting |
| [dsa-integration-notes.md](dsa-integration-notes.md), [dsa-proctoring-implementation.md](dsa-proctoring-implementation.md) | DSA module notes (questions, harnesses, API) and browser proctoring |
| [AI_TECHNICAL_INTERVIEW.md](AI_TECHNICAL_INTERVIEW.md) | AI technical interview round: hand-over after any round HR chose, resume / job / scenario questions with adaptive follow-ups, voice pipeline, camera + mic, evidence-based report, HR decision, security, tests, limits |
| [SCREENING_ROUND.md](SCREENING_ROUND.md) | M12 AI voice screening round: flow, voice architecture, security/privacy, running, tests, deployment plan, limits |
| [PROJECT_MAP.md](PROJECT_MAP.md) | Simple one-file map: every folder, how apps/API/AI worker/database are wired, main flows, where to change what |
| [HireFlow_AI_Documentation.md](HireFlow_AI_Documentation.md) | Full product + architecture spec |
| [TEAM_GUIDE.md](TEAM_GUIDE.md) | Team workflow, setup, conventions |
| [FOLDER_STRUCTURE.md](FOLDER_STRUCTURE.md) | Every folder: purpose, owner, and what is built vs. placeholder |
| [JD_WORKFLOW.md](JD_WORKFLOW.md) | The full JD flow (company profile → job → AI JD → HR approval): how it was built, step by step, and how to run, test, and extend it |
| [MULTI_COMPANY_AUTH.md](MULTI_COMPANY_AUTH.md) | Login, roles (Platform Admin / Company Admin / HR Member), invitations, company isolation: what was added, why, how to run and test it |

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).
