// HTTP API. Every capability is an API endpoint first (UI comes later as a client).
// Auth: send header `x-api-key: <FLOW_API_KEY>`. /health and /hooks/* are the exceptions
// (/hooks use a per-flow secret instead).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { makeAlerter } from './alerts.js';

export const VERSION = '0.1.0';

export async function loadFlows(engine, dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    engine.register(mod.default);
  }
}

export function createApp({ dataDir, apiKey, flowsDir, env = process.env }) {
  const store = new Store(dataDir);
  const engine = new Engine({ store, alert: makeAlerter(store, env) });
  const startedAt = new Date().toISOString();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const parts = url.pathname.split('/').filter(Boolean);

      if (url.pathname === '/health') {
        return send(200, { ok: true, version: VERSION, startedAt, flows: engine.flows.size });
      }

      // Webhook trigger: POST /hooks/<flowId>?secret=<flow.webhookSecret>
      if (parts[0] === 'hooks' && req.method === 'POST') {
        const flow = engine.flows.get(parts[1]);
        if (!flow?.webhookSecret || url.searchParams.get('secret') !== flow.webhookSecret) return send(404, { error: 'not found' });
        return send(202, await engine.trigger(flow.id, await readJson(req), 'webhook'));
      }

      if (!apiKey || req.headers['x-api-key'] !== apiKey) return send(401, { error: 'unauthorised' });

      if (url.pathname === '/api/summary') return send(200, engine.summary());
      if (url.pathname === '/api/flows') return send(200, engine.summary().flows);
      if (parts[1] === 'flows' && parts[3] === 'run' && req.method === 'POST') {
        return send(200, await engine.trigger(parts[2], await readJson(req), 'manual'));
      }
      if (parts[1] === 'flows' && (parts[3] === 'pause' || parts[3] === 'resume') && req.method === 'POST') {
        return send(engine.setEnabled(parts[2], parts[3] === 'resume') ? 200 : 404, { ok: true });
      }
      if (url.pathname === '/api/runs') {
        const status = url.searchParams.get('status');
        const rows = store.list('runs', (r) => !status || r.status === status).slice(-100).reverse();
        return send(200, rows);
      }
      if (url.pathname === '/api/approvals') {
        return send(200, store.list('approvals', (a) => a.status === 'pending'));
      }
      if (parts[1] === 'approvals' && ['approve', 'reject'].includes(parts[3]) && req.method === 'POST') {
        return send(200, await engine.decide(parts[2], parts[3]));
      }
      if (url.pathname === '/api/alerts') return send(200, store.list('alerts').slice(-50).reverse());

      return send(404, { error: 'not found' });
    } catch (err) {
      return send(500, { error: err.message });
    }
  });

  return { server, engine, store, ready: loadFlows(engine, flowsDir) };
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('payload too large');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}
