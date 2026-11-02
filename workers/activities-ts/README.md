# activities-ts

| | |
|---|---|
| **Owner** | Intern 1 (Core & HR) |
| **Doc modules** | M29/M24 |
| **Release** | v0.1+ |

Temporal activities written in TypeScript (email, publish, calendar).

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).
