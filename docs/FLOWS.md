# DS Flow — guide for other builds
How DSOS, the marketing system, Creative Buddy or any other DarkSpace build uses DS Flow.
Two parts: **add a flow** (a file in this repo) and **talk to DS Flow** (the client library or plain HTTP).

## 1. Add a flow
Flows are files, not API records. A flow is added by commit to `flows/<id>.js` in Jacabew/Flow, with a test in `test/`.
`npm test` green → push → the HUB deploys within 5 min and rolls back if health fails. No runtime "register" call exists, on purpose (see DECISIONS 2026-11-04).

```js
// flows/marketing-weekly-post.js
export default {
  id: 'marketing-weekly-post',            // unique, lowercase-dashes; becomes /api/flows/<id>
  description: 'One line on what it does.',
  agent: 'marketing',                     // optional: limits what it may touch (agents/*.js)
  schedule: { weekly: 'Tue 09:00' },      // optional; Brisbane time
  webhookSecret: () => readSecret(),      // optional; turns on POST /hooks/<id>?secret=…
  steps: [
    { type: 'dsos', name: 'jobs', path: '/api/v1/jobs', query: { status: 'open' } },
    { type: 'code', name: 'pick', fn: (c) => c.steps.jobs.body.slice(0, 3) },
    { type: 'if', name: 'any', when: (c) => c.steps.pick.length > 0 },
    { type: 'approval', name: 'ok', title: 'Post this week?', detail: (c) => c.steps.pick },
    { type: 'log', name: 'done', message: (c) => `picked ${c.steps.pick.length}` },
  ],
};
```

### Triggers
| Trigger | How |
|---|---|
| Every N minutes | `schedule: { everyMinutes: 15 }` |
| Daily | `schedule: { dailyAt: '07:30' }` |
| Some days | `schedule: { weekly: 'Mon,Fri 07:30' }` or `{ dailyAt, days: ['Mon','Fri'] }` |
| Webhook | `webhookSecret: 'x'` or a function returning it (read from `C:\Flow\secrets` on the HUB, never in the repo). No secret = webhook off. |
| On demand | Always: `POST /api/flows/<id>/run` (client: `runFlow`). |

A bad schedule fails at load, so a typo can't silently never fire.

### Step types
Every step: `type`, optional `name` (output lands at `ctx.steps[name]`), `retries`, `retryDelayMs`, `timeoutMs` (default 5 min; 30 s for `http`/`dsos`). Any config value can be a function of `ctx`.

| Type | Config | Output |
|---|---|---|
| `http` | `url`, `method`, `headers`, `body` | `{ status, body }`; non-2xx throws |
| `dsos` | `path` (`/api/v1/…`), `method`, `query`, `body`, `live` | see API.md. Writes are shadow unless `live: true` **and** the HUB has writes switched on |
| `code` | `fn: (ctx) => value` | whatever `fn` returns |
| `if` | `when: (ctx) => bool` | `{ pass }`; false skips the remaining steps |
| `wait` | `ms` | short waits only; long gaps = a scheduled flow |
| `approval` | `title`, `detail` | pauses the run until approved/rejected in `/inbox` |
| `log` | `message` | `{ message }` |

`ctx` has `input` (trigger body), `steps` (earlier outputs), `flowId`, `runId`, `signal` (aborts on timeout).

### House rules (from CLAUDE.md)
- Anything that sends email, touches Xero or moves money starts in **shadow mode** and only goes live after Jake's yes in CHECKIN.
- No AI inside the engine. If a flow needs AI later it'll be an opt-in step type.
- Every run is logged and every failure alerts; you don't need to add that.
- Give the flow an `agent` if it acts for a business purpose (sends, writes). System checks don't need one.

## 2. Talk to DS Flow
### Client library (Node 22+ or a browser, no dependencies)
Copy `client/index.js` into your build, or install the repo and `import … from 'ds-flow/client'`.

```js
import { createFlowClient, FlowApiError } from 'ds-flow/client';
const flow = createFlowClient({ baseUrl: 'http://127.0.0.1:5680', apiKey: process.env.FLOW_API_KEY });

const tile = await flow.summary();               // Mission Control tile (schema 1)
await flow.runFlow('marketing-weekly-post', { note: 'manual' });
for (const a of await flow.approvals()) await flow.approve(a.id);
await flow.triggerWebhook('enquiry-responder-shadow', secret, { email: 'a@b.com' }); // no API key sent
```

| Method | Endpoint |
|---|---|
| `health()` | `GET /health` (no key) |
| `summary()`, `connectors()`, `alerts()` | `GET /api/summary`, `/api/connectors`, `/api/alerts` |
| `flows()`, `runFlow(id, input)`, `pauseFlow(id)`, `resumeFlow(id)` | `/api/flows…` |
| `runs({ status })` | `GET /api/runs` |
| `approvals()`, `approve(id)`, `reject(id)` | `/api/approvals…` |
| `agents()`, `pauseAgent(id)`, `resumeAgent(id)`, `pauseAllAgents()`, `resumeAllAgents()` | `/api/agents…` |
| `shadow({ flow })`, `shadowReport(name)` | `GET /api/shadow`, `/api/shadow/<name>` |
| `triggerWebhook(flowId, secret, body)` | `POST /hooks/<flowId>?secret=…` |

- Non-2xx → throws `FlowApiError` with `.status` and `.body` (e.g. 401 wrong key, 404 unknown flow/approval/agent, 429 too many bad keys).
- No retries inside the client; the caller decides. Default timeout 30 s (`timeoutMs`).
- The API key comes from the caller's own secret store. Never commit it.

### Plain HTTP
Everything the client does is in [API.md](API.md): header `x-api-key`, JSON in and out.
