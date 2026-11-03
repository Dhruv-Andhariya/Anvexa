# dsa

| | |
|---|---|
| **Owner** | DSA assessment developer |
| **Release** | v0.4 (runs the round engine's coding rounds) |

Candidate DSA coding assessment: questions, server-side timer, Judge0 execution, scoring.

## How it runs in the app
A job round with only **Coding** questions and a score pass rule is a coding round. The round engine invites students
who pass the round before it (email with `DSA_SITE_URL/dsa/<token>`), and `integration/round-engine.bridge.ts` connects
the two: the emailed round-engine link is the token, the attempt is recorded in the round engine when the clock starts,
the page's state is kept in `dsa_sessions`, and when the attempt ends (finish, time-out, integrity end) the round engine
grades it against HR's pass rule and queues the next invite or the outcome email.

## Rules for this folder
- Only `integration/` imports from `round-engine` (its public `index.ts`). Everything else stays self-contained.
- Hidden test cases live only in `questions/` and are never serialised to a client (`toPublicQuestion` is a whitelist).
- Swap data sources through the `DSA_QUESTION_REPOSITORY`, `DSA_INVITATION_RESOLVER`, `DSA_SESSION_STORE` and
  `DSA_LIFECYCLE` tokens. The questions are still the 3 built-in problems (HR's coding questions have no test cases).
- Full notes: `docs/dsa-integration-notes.md`.
