# DS Flow — task queue
Build sessions take the first unchecked item. Keep items small (one session each).

## Phase 0 — self-running build pipeline
- [x] Repo scaffold, rules (CLAUDE.md), brief, task queue
- [x] Engine core: steps, retries, run log, approvals, pause/resume, alerts (with tests)
- [x] Scheduler: every-N-minutes and daily-at (Brisbane time), heartbeat flow
- [x] HTTP API with key auth, webhook triggers with per-flow secret
- [x] GitHub Actions CI (Node 22 + 24)
- [x] HUB auto-deploy script: pull → test on HUB → restart → health check → auto-rollback → status to OneDrive
- [x] HUB one-time installer (service + 5-minute deploy task)
- [ ] **Jake (Wed session):** run `deploy/hub/install.ps1` on the HUB once
- [x] Nightly scheduled build task (10:36pm Brisbane, auto-approve) created
- [ ] Confirm first auto-deploy landed (read OneDrive\FLOW\status\deploy-status.json)

## Phase 1 — engine hardening
- [ ] Watchdog flow: alert if heartbeat hasn't succeeded in 15 min
- [ ] Daily summary flow: writes yesterday's runs/failures to OneDrive\FLOW\status\daily.json
- [ ] Run retention: archive runs older than 30 days to monthly files
- [ ] Recover runs left "running" after a restart (mark failed + alert)
- [ ] Step timeout for every step type (not just http)
- [ ] Weekly cron-style schedule support (e.g. "Mon,Wed 07:30") — check existing `days` covers it first

## Phase 2 — approval inbox + Mission Control tile
- [ ] Mobile web page at /inbox: list pending approvals, approve/reject buttons (login with API key once, remembered)
- [ ] Decide how Jake reaches /inbox from his phone (Caddy route on HUB vs DSOS proxies it) → DSOS_REQUESTS if DSOS
- [ ] `/api/summary` shape frozen + documented for the DSOS Mission Control tile → DSOS_REQUESTS.md

## Phase 3 — move existing automations onto DS Flow (shadow mode first)
- [ ] DSOS connector (reads/writes DSOS API) — needs DSOS API key on HUB
- [ ] Daily Xero back-feed: shadow run, compare with DSOS's own sync for 1 week
- [ ] Recurring invoices (workshop rent): shadow run only
- [ ] Enquiry responder: shadow run (drafts, doesn't send)

## Phase 4 — agent registry + guardrails
- [ ] Agent registry: id, job, allowed connectors/actions, auto vs needs-approval actions
- [ ] Guardrails: daily send/spend limits per agent, global pause switch
- [ ] First agent live: enquiry responder (after Jake's yes in CHECKIN)

## Phase 5 — reusable for other projects
- [ ] Small client library + API docs so other builds (marketing, Creative Buddy) can register flows
