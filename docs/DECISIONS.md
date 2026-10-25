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
- 2026-10-24 · **Archive lives in the data folder** (`C:\Flow\data\archive`), not OneDrive (Claude). Same reason as runs: live data stays out of OneDrive. Archive files are compact JSON, one per Brisbane month; nothing reads them yet.
- 2026-10-24 · **Only finished runs are archived** (Claude). `running` and `waiting_approval` stay live however old, so an approval Jake hasn't answered is never lost.
- 2026-10-24 · **Run cap raised 5,000 → 20,000** (Claude). Heartbeat + watchdog alone make ~580 runs/day, so 5,000 would have deleted runs before the 30-day retention could archive them. The cap is now a safety net only. Added a task to move off whole-file JSON if runs.json grows past ~5 MB.
- 2026-10-24 · **Restart recovery = mark failed + alert, no auto-retry** (Claude). A run cut off mid-step may have half-done a side effect; re-running it blindly could double-send. One alert per stuck run.
- 2026-10-25 · **Default step timeout 5 min** for code/log/if/approval (Claude). Long enough for any real step; short enough that a hung step can't hold a run (and the watchdog) hostage. http keeps its own 30s request timeout; wait steps get their length + 5s.
- 2026-10-25 · **Timed-out work is abandoned, not killed** (Claude). Node can't kill a running promise, so a step that ignores `ctx.signal` may still finish its side effect after the run is marked failed. Connectors that send, pay or write must pass `ctx.signal` through (http already does). No auto-retry beyond the step's own `retries`.
- 2026-10-25 · **Weekly = existing `days` plus a `weekly` shorthand** (Claude). `days` already covered "Mon,Wed 07:30" for one time of day; added `weekly: 'Mon,Wed 07:30'` and day names. No full cron syntax: not needed yet. Multiple times a day = register two flows or add later.
