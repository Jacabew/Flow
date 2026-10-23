# DS Flow

DarkSpace's own lightweight automation and agent manager. Think n8n, minus the canvas and the subscription.

- **Flows** live in `flows/*.js`: a trigger (schedule or webhook) and a list of steps.
- **Steps:** `http`, `code`, `if`, `wait`, `approval`, `log`. Connectors are built on `http` as needed.
- **Every run is logged**, failures retry and alert, approvals pause a run until Jake decides.
- **Self-deploying:** push to `main` → HUB tests, deploys, health-checks and rolls back on its own.

## Run locally
```
npm test
FLOW_API_KEY=dev npm start   # http://127.0.0.1:5680/health
```

## API (header `x-api-key`)
| Method | Path | What |
|---|---|---|
| GET | /health | Liveness (no key) |
| GET | /api/summary | Mission Control tile: ok, runs, failed, pending approvals |
| GET | /api/flows | Flows and on/off state |
| POST | /api/flows/:id/run | Run a flow now |
| POST | /api/flows/:id/pause, /resume | Switch a flow off/on |
| GET | /api/runs?status=failed | Recent runs |
| GET | /api/approvals | Pending approvals |
| POST | /api/approvals/:id/approve, /reject | Decide |
| GET | /api/alerts | Recent alerts |
| POST | /hooks/:flowId?secret=… | Webhook trigger (per-flow secret) |

## Example flow
```js
export default {
  id: 'big-quote-check',
  webhookSecret: 'from-env-not-repo',
  steps: [
    { type: 'if', name: 'big', when: (c) => c.input.total > 20000 },
    { type: 'approval', title: (c) => `Send quote ${c.input.number}?` },
    { type: 'http', method: 'POST', url: 'http://127.0.0.1:3000/api/quotes/send', body: (c) => ({ id: c.input.id }) },
  ],
};
```

## Docs
`docs/BRIEF.md` (why/scope) · `docs/TASKS.md` (queue) · `docs/BUILD_LOG.md` · `docs/DECISIONS.md` · `docs/CHECKIN.md` (Jake's page) · `CLAUDE.md` (builder rules)
