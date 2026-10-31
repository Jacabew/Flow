# Changes DS Flow needs from DSOS
DS Flow never edits DSOS. Jake takes these to the DSOS Build project when ready.
Both assume DS Flow is installed on the HUB (port 5680, bound to 127.0.0.1).

## 1. Caddy route so Jake's phone can reach the approval inbox (added 27 Oct)
DS Flow stays bound to 127.0.0.1; the HUB's existing Caddy fronts it with HTTPS. Only the
inbox and the two approval endpoints it uses are exposed; everything else returns 404.
- **DNS:** `flow.darkspace.au` → same public IP as `dsos.darkspace.au` (A or CNAME).
- **Caddyfile:** add this site block, then `caddy reload`:
  ```
  flow.darkspace.au {
    @inbox path /inbox /health /api/approvals /api/approvals/*
    handle @inbox {
      reverse_proxy 127.0.0.1:5680
    }
    handle {
      respond 404
    }
  }
  ```
- **Test (1 min):** open `https://flow.darkspace.au/inbox` on the phone, paste the Flow API key once,
  see "Nothing waiting". `https://flow.darkspace.au/api/summary` should be 404.
- Safety already in DS Flow: API key required on every data call, 10 wrong keys → that client locked out 15 min,
  page holds no data, no framing, strict CSP.

## 2. Mission Control tile: "Automations" (added 27 Oct)
- DSOS server (not the browser) calls `GET http://127.0.0.1:5680/api/summary` with header `x-api-key`.
  Key stored in DSOS's own secrets on the HUB, never in the DSOS repo.
- Show `headline` as the tile text; colour from `status` (green / amber / red). Tap → `https://flow.darkspace.au/inbox`.
- If the call fails or times out (2 s), show grey "Automations: no signal" — DSOS must not break if DS Flow is down.
- Shape is frozen as schema 1: see `docs/API.md` in the Flow repo.

## 3. A read-only API token for DS Flow (added 29 Oct)
DS Flow's DSOS connector is built and waiting for a token. Nothing uses it until then.
- In DSOS, issue DS Flow **its own scoped token**, read-only for now (jobs, clients, invoices, todos, mission-control attention). Not the full API token.
- Save it on the HUB as `C:\Flow\secrets\dsos-token.txt` (one line). No restart needed. Never in either repo.
- **Test (1 min):** `Invoke-RestMethod http://127.0.0.1:5680/api/connectors -Headers @{ 'x-api-key' = (Get-Content C:\Flow\secrets\api-key.txt) }` shows `configured: True`.
- Writes stay in shadow mode (logged, not sent) until a flow needs them and Jake says yes in CHECKIN.

## 4. Xero back-feed status endpoint (added 30 Oct)
DS Flow is shadowing DSOS's daily Xero back-feed for a week before taking over its schedule (and alerting when it fails).
- Add `GET /api/v1/xero/sync-status` → `{ "lastRunAt": "<ISO time of last back-feed run>", "ok": true|false, "error": "<text or null>" }`.
  Read-only; include it in DS Flow's read-only token scope (#3).
- **Later, only at switch-over (Jake's yes in CHECKIN first):** let DS Flow's token call the same sync the "Refresh from Xero" button runs, e.g. `POST /api/v1/xero/sync` (rate-limited as now), and turn off DSOS's own morning cron. Not now.
- **Test (1 min):** after #3 and this, `Invoke-RestMethod http://127.0.0.1:5680/api/shadow/xero-backfeed -Headers @{ 'x-api-key' = (Get-Content C:\Flow\secrets\api-key.txt) }` the next morning shows today as `match`.

## 5. Recurring invoice schedules, read-only (added 31 Oct)
DS Flow is shadowing DSOS's recurring invoices (workshop rent) before it ever triggers them. It never creates invoices or touches Xero.
- Add (or confirm) `GET /api/v1/recurring-invoices` → list of schedules, each with:
  `id`, `description`, `active`, `nextRunOn` (Brisbane date DSOS will next generate it, `YYYY-MM-DD`), `amountExGst`,
  and `recentRuns`: last 3 generated `[{ date, invoiceId, number, totalExGst }]`. Include it in DS Flow's read-only token scope (#3).
- **Later, only at switch-over (Jake's yes in CHECKIN first):** let DS Flow's token call `POST /api/v1/recurring-invoices/generate-due` `{ day, scheduleIds }` (runs the same code as DSOS's own job, idempotent per schedule per period) and turn off DSOS's own recurring cron. Not now.
- **Test (1 min):** after #3 and this, `Invoke-RestMethod http://127.0.0.1:5680/api/shadow/recurring-invoices -Headers @{ 'x-api-key' = (Get-Content C:\Flow\secrets\api-key.txt) }` the evening after a rent invoice shows that day as `match`.
