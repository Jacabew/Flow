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
