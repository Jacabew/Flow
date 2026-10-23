# DS Flow — build log
Facts only. What exists now that didn't before.

- 2026-10-23: Repo created. Engine core (steps, retries, run log, approvals, pause/resume, alerts), scheduler (Brisbane time), HTTP API with key auth + webhook triggers, heartbeat flow, 13 passing tests, CI on Node 22/24, HUB auto-deploy script with test gate + health check + auto-rollback, one-time HUB installer. Not yet installed on the HUB.
- 2026-10-23 (night build): Watchdog flow (every 5 min; alerts once per outage if no successful heartbeat in 15 min; 15-min start-up grace; logs recovery). Daily summary flow (00:10 Brisbane; writes yesterday's runs/failures/alerts per flow to FLOW_STATUS_DIR\daily.json, atomic write). Flows can now read run history via ctx.store/ctx.now/ctx.engineStartedAt. Installer sets FLOW_STATUS_DIR=OneDrive\FLOW\status. 22 passing tests.
