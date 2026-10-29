# DS Flow — API reference
Base: `http://127.0.0.1:5680` on the HUB. JSON in, JSON out.
Auth: header `x-api-key: <FLOW_API_KEY>` on every `/api/*` call. Exceptions: `/health`, `/inbox` (static page), `/hooks/*` (per-flow secret).
Wrong key → `401`. 10 wrong keys from one client in 15 min → `429` for that client until the window clears.

## GET /api/summary — Mission Control tile (schema 1, frozen)
Last 24 h. **Frozen:** fields may be added later, never renamed, removed or re-typed. A breaking change would ship as `schema: 2`.

```json
{
  "schema": 1,
  "generatedAt": "2026-10-27T00:00:00.000Z",
  "sinceHours": 24,
  "ok": false,
  "status": "red",
  "headline": "Automations: 2 failed",
  "runs": 581,
  "failed": 2,
  "failedFlows": ["xero-backfeed"],
  "lastFailureAt": "2026-10-26T21:15:00.000Z",
  "pendingApprovals": 1,
  "flows": [{ "id": "heartbeat", "enabled": true }]
}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | number | Always `1` for this shape. |
| `generatedAt` | ISO UTC string | When the summary was built. |
| `sinceHours` | number | Window covered (24). |
| `ok` | boolean | `true` when no run failed in the window. |
| `status` | `"green"` \| `"amber"` \| `"red"` | red = any failure; amber = no failures but approvals waiting; else green. |
| `headline` | string | Ready to show as-is: `Automations: all green` / `Automations: N waiting for approval` / `Automations: N failed`. |
| `runs` | number | Runs started in the window. |
| `failed` | number | Of those, how many failed. |
| `failedFlows` | string[] | Flow ids with a failure in the window, sorted, no duplicates. |
| `lastFailureAt` | ISO UTC string \| null | Start time of the newest failed run. |
| `pendingApprovals` | number | Approvals waiting now (any age). |
| `flows` | `{id, enabled}[]` | Every registered flow and whether it's switched on. |

Tile rule of thumb: colour from `status`, text from `headline`, tap → `/inbox` when amber.

## Other endpoints
| Method + path | What |
|---|---|
| `GET /health` | `{ ok, version, startedAt, flows }`. No key. |
| `GET /inbox` | Phone approval page. No key (page holds no data). |
| `GET /api/flows` | Same as `summary.flows`. |
| `POST /api/flows/:id/run` | Run a flow now; body = input. |
| `POST /api/flows/:id/pause` / `resume` | Switch a flow off/on. 404 if unknown. |
| `GET /api/runs?status=failed` | Newest 100 runs, optional status filter. |
| `GET /api/approvals` | Pending approvals. |
| `POST /api/approvals/:id/approve` / `reject` | Decide. 404 if unknown. |
| `GET /api/alerts` | Newest 50 alerts. |
| `GET /api/connectors` | `{ dsos: { baseUrl, configured, tokenSource, writesLive } }`. Never includes tokens. |
| `GET /api/shadow?flow=` | Newest 100 writes logged in shadow mode (not sent): `{ connector, flowId, runId, at, method, path, query, body }`. |
| `POST /hooks/:flowId?secret=…` | Webhook trigger. 404 on wrong secret. |

## Step type `dsos` (for flow authors)
```js
{ type: 'dsos', name: 'jobs', path: '/api/v1/jobs', query: { status: 'open' } }             // read
{ type: 'dsos', method: 'POST', path: '/api/v1/todos', body: (c) => ({ ... }) }            // shadow write
{ type: 'dsos', method: 'POST', path: '/api/v1/todos', body: { ... }, live: true }          // live only if FLOW_DSOS_WRITES=live
```
- Output: read `{ status, body }`; shadow write `{ shadow: true, reason, wouldSend }`; live write `{ status, body, live: true }`.
- `path` must start with `/api/v1/`, plain characters only (no `%`, `?`, `..`); put parameters in `query`.
- Reads retry twice, writes never retry (set `retries` to override). Timeout 30 s (`timeoutMs`).
- HUB config: `FLOW_DSOS_URL` (default `http://127.0.0.1:3000`), token in `FLOW_DSOS_TOKEN` or `%FLOW_SECRETS_DIR%\dsos-token.txt`.
