# DS Flow — rules for every Claude session (read first)

DS Flow is DarkSpace's own lightweight automation and agent manager (an n8n alternative, no subscription).
Owner: Jake Wood. Read `docs/BRIEF.md` for the why and the scope.

## The prime constraint
Jake gives **5 min on Mon and Fri mornings and 30 min on Wednesday**. Nothing else.
- Never stall waiting on Jake. Make the call, record the assumption in `docs/DECISIONS.md`, keep going.
- Only stop for a decision that is **irreversible and could reasonably go either way**. Put it in `docs/CHECKIN.md`.
- Everything Jake needs to see goes in `docs/CHECKIN.md`: max 3 items, each a yes/no or a 1-minute test.

## Blast radius (hard rules)
- Work ONLY in this repo. **Never** modify DSOS (`Jacabew/DarkSpace-Operating-System---Private`) or anything live in DSOS.
  If DS Flow needs a DSOS change (e.g. a Mission Control tile), write it up in `docs/DSOS_REQUESTS.md` for Jake to take to the DSOS Build project.
- No secrets in the repo. Ever. Secrets live on the HUB in `C:\Flow\secrets`.
- Nothing that sends email, touches Xero or moves money runs live until it has run in **shadow mode** (logs what it *would* do) and Jake has said yes in CHECKIN.

## How a build session works
1. `npm test` must pass before you start (if not, fixing it is the task).
2. Take the **first unchecked item** in `docs/TASKS.md`. Keep it small enough to finish this session.
3. Build it with tests. Zero runtime dependencies unless there's a strong reason (record it in DECISIONS).
4. `npm test` green → commit and push to `main`. The HUB auto-deploys within 5 minutes, re-runs tests,
   health-checks and rolls back on failure. You don't need Jake for this.
5. Tick the task, add a dated line to `docs/BUILD_LOG.md` (facts only: what exists now that didn't before),
   update `docs/CHECKIN.md` if Jake needs to see something.
6. If the linked computer is available, read `OneDrive\FLOW\status\deploy-status.json` to confirm the deploy landed.

## Engineering rules
- Plain Node.js (22+), ES modules, `node:test`. Boring and durable.
- Deterministic core: no AI calls inside the engine. AI is a step type flows can opt into later.
- Every capability is an API endpoint first; UI is just a client.
- Every run is logged. Every failure alerts. An alert failing must never crash the engine.
- Brisbane time is UTC+10 with no daylight saving.

## Style for anything Jake reads
Concise, scannable, plain words. Colour temps as "3K", "2K7".
