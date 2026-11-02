# ui

| | |
|---|---|
| **Owner** | Intern 1 (Core & HR) |
| **Doc modules** | - |
| **Release** | v0.1 |

Shared React components (shadcn/ui). Anyone may add a component via PR.

## Rules for this folder
- Only the owner edits this folder. Need a change? Open an issue or a small PR and tag the owner.
- Other modules may import this module ONLY through `index.ts` (never its internals or tables).
- Events this module sends/listens to are defined in `packages/contracts` (see doc section 10.5).
- "Done" means: code behind a feature flag, tests, events in contracts, audit logging, retries, this README updated (doc 18.1).
