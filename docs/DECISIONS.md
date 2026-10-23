# DS Flow — decisions and assumptions
Jake can veto any of these in the Wednesday session.

- 2026-10-23 · **Own repo** (Jake). Standalone, reusable by DSOS and other builds via API.
- 2026-10-23 · **Jake's time:** Mon + Fri 7:30am 5 min, Wed 8:00am 30 min (Jake; Wed time picked by Claude).
- 2026-10-23 · **Self-managing:** tests are the merge gate; HUB auto-deploys and auto-rolls back. No human clicks (Jake).
- 2026-10-23 · **Zero runtime dependencies**, plain Node 22+ (Claude). Avoids native builds on Windows and supply-chain risk.
- 2026-10-23 · **JSON-file store** instead of SQLite for now (Claude). Volumes are tiny; behind an interface so it can be swapped later.
- 2026-10-23 · **Runs from C:\Flow, not OneDrive** (Claude). OneDrive syncing fights git and live data files. OneDrive\FLOW only gets small status files so Claude can see HUB state remotely. The OneDrive\FLOW\GITHUB folder Jake made isn't needed for running it.
- 2026-10-23 · **Port 5680, bound to 127.0.0.1** (Claude). Not exposed to the internet until a phase needs it (webhooks from the website, phone inbox).
- 2026-10-23 · **Phone alerts via ntfy.sh** (Claude). Free, no account, no subscription. Optional.
- 2026-10-23 · **Deploy task runs as SYSTEM with a read-only GitHub token** if the repo is private (Claude). So it works with nobody logged in.
- 2026-10-23 · **Watchdog alerts once per outage**, not every 5 min, and gives 15 min grace after any restart (Claude). Avoids phone spam and false alarms on deploy restarts.
- 2026-10-23 · **Flows get read access to the store via ctx** (Claude). Needed for system flows (watchdog, daily summary). Flows are repo code, so this isn't a trust boundary.
- 2026-10-23 · **daily.json covers the previous Brisbane calendar day**, written at 00:10 (Claude). If FLOW_STATUS_DIR is unset the flow succeeds and writes nothing. The OneDrive copy of install.ps1 may predate FLOW_STATUS_DIR; refresh it next time the linked computer is available (task added).
