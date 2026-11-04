// DS Flow client: a small, zero-dependency wrapper over the DS Flow HTTP API (docs/API.md).
// For other DarkSpace builds (DSOS, marketing, Creative Buddy) that want to run flows, read
// status, or decide approvals. Node 22+ or any modern browser (uses global fetch).
//
//   import { createFlowClient } from 'ds-flow/client';     // or a relative path to this file
//   const flow = createFlowClient({ baseUrl: 'http://127.0.0.1:5680', apiKey: process.env.FLOW_API_KEY });
//   const tile = await flow.summary();
//   await flow.runFlow('heartbeat');
//
// Errors: any non-2xx reply throws FlowApiError { status, body }. Network failures and
// timeouts throw the underlying fetch error. Nothing here retries: callers decide.
//
// Registering a flow is NOT an API call: flows are files in this repo (flows/*.js), added by
// commit so every change is tested and the HUB can roll it back. See docs/FLOWS.md.

export class FlowApiError extends Error {
  constructor(status, body, method, path) {
    const detail = body && typeof body === 'object' && body.error ? body.error : String(body ?? '').slice(0, 200);
    super(`DS Flow ${method} ${path} → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'FlowApiError';
    this.status = status;
    this.body = body;
  }
}

const seg = (v) => {
  const s = String(v ?? '');
  if (!s) throw new TypeError('DS Flow client: id must be a non-empty string');
  return encodeURIComponent(s);
};

export function createFlowClient({ baseUrl, apiKey, timeoutMs = 30_000, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new TypeError('DS Flow client: baseUrl is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('DS Flow client: no fetch available');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function call(method, path, { body, query, auth = true } = {}) {
    const qs = query
      ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString()
      : '';
    const headers = {};
    if (auth) {
      if (!apiKey) throw new TypeError('DS Flow client: apiKey is required for /api/* calls');
      headers['x-api-key'] = apiKey;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) throw new FlowApiError(res.status, parsed, method, path);
    return parsed;
  }

  const get = (p, query) => call('GET', p, { query });
  const post = (p, body) => call('POST', p, { body });

  return {
    baseUrl: base,

    // Status
    health: async () => call('GET', '/health', { auth: false }),
    summary: async () => get('/api/summary'),
    connectors: async () => get('/api/connectors'),
    alerts: async () => get('/api/alerts'),

    // Flows and runs
    flows: async () => get('/api/flows'),
    runFlow: async (id, input = {}) => post(`/api/flows/${seg(id)}/run`, input),
    pauseFlow: async (id) => post(`/api/flows/${seg(id)}/pause`),
    resumeFlow: async (id) => post(`/api/flows/${seg(id)}/resume`),
    runs: async ({ status } = {}) => get('/api/runs', { status }),

    // Approvals
    approvals: async () => get('/api/approvals'),
    approve: async (id) => post(`/api/approvals/${seg(id)}/approve`),
    reject: async (id) => post(`/api/approvals/${seg(id)}/reject`),

    // Agents
    agents: async () => get('/api/agents'),
    pauseAgent: async (id) => post(`/api/agents/${seg(id)}/pause`),
    resumeAgent: async (id) => post(`/api/agents/${seg(id)}/resume`),
    pauseAllAgents: async () => post('/api/agents/pause-all'),
    resumeAllAgents: async () => post('/api/agents/resume-all'),

    // Shadow mode (writes logged, not sent) and the per-flow switch-over reports
    shadow: async ({ flow } = {}) => get('/api/shadow', { flow }),
    shadowReport: async (name) => get(`/api/shadow/${seg(name)}`),

    // Webhook trigger: uses the flow's own secret, not the API key.
    triggerWebhook: async (flowId, secret, body = {}) =>
      call('POST', `/hooks/${seg(flowId)}`, { body, query: { secret }, auth: false }),
  };
}
