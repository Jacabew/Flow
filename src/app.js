// HTTP API. Every capability is an API endpoint first (UI comes later as a client).
// Auth: send header `x-api-key: <FLOW_API_KEY>`. /health and /hooks/* are the exceptions
// (/hooks use a per-flow secret instead).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { makeDsosClient } from './connectors/dsos.js';
import { Engine } from './engine.js';
import { makeAlerter } from './alerts.js';
import { INBOX_HTML } from './inbox.js';
import { backfeedReport } from './backfeed.js';
import { recurringReport } from './recurring.js';

export const VERSION = '0.1.0';

export async function loadFlows(engine, dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    engine.register(mod.default);
  }
}

// Brute-force guard for when /inbox is reachable from outside (via Caddy on the HUB):
// a client that sends 10 wrong keys within 15 min gets 429 until the window clears.
export const AUTH_MAX_FAILS = 10;
export const AUTH_WINDOW_MS = 15 * 60_000;

function keyMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Behind Caddy every request comes from loopback; Caddy appends the real client IP as the
// LAST X-Forwarded-For entry, so use that (earlier entries can be forged by the client).
function clientId(req) {
  const remote = req.socket.remoteAddress ?? '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  if (loopback && typeof xff === 'string' && xff.trim()) return xff.split(',').at(-1).trim();
  return remote;
}

export function createApp({ dataDir, apiKey, flowsDir, env = process.env, now = () => Date.now() }) {
  const authFails = new Map(); // clientId -> [timestamps of failed attempts]
  const store = new Store(dataDir);
  const dsos = makeDsosClient({ env });
  const engine = new Engine({ store, alert: makeAlerter(store, env), connectors: { dsos } });
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

      // Phone approval inbox. The page is static and holds no data; it calls /api/* with the key.
      if (url.pathname === '/inbox' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
        });
        return res.end(INBOX_HTML);
      }

      // Webhook trigger: POST /hooks/<flowId>?secret=<flow.webhookSecret>
      if (parts[0] === 'hooks' && req.method === 'POST') {
        const flow = engine.flows.get(parts[1]);
        if (!flow?.webhookSecret || url.searchParams.get('secret') !== flow.webhookSecret) return send(404, { error: 'not found' });
        return send(202, await engine.trigger(flow.id, await readJson(req), 'webhook'));
      }

      const who = clientId(req);
      const t = now();
      const fails = (authFails.get(who) ?? []).filter((at) => t - at < AUTH_WINDOW_MS);
      if (fails.length >= AUTH_MAX_FAILS) return send(429, { error: 'too many failed attempts, try again later' });
      if (!keyMatches(req.headers['x-api-key'], apiKey)) {
        fails.push(t);
        if (authFails.size > 1000) authFails.clear(); // bound memory; worst case resets counters
        authFails.set(who, fails);
        return send(401, { error: 'unauthorised' });
      }

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
        if (!store.get('approvals', parts[2])) return send(404, { error: 'approval not found' });
        return send(200, await engine.decide(parts[2], parts[3]));
      }
      // Connector status (never includes tokens) and the shadow log of writes not sent.
      if (url.pathname === '/api/connectors') return send(200, { dsos: dsos.config() });
      if (url.pathname === '/api/shadow/xero-backfeed') return send(200, backfeedReport(store, engine.now()));
      if (url.pathname === '/api/shadow/recurring-invoices') return send(200, recurringReport(store, engine.now()));
      if (url.pathname === '/api/shadow') {
        const flow = url.searchParams.get('flow');
        return send(200, store.list('shadow', (r) => !flow || r.flowId === flow).slice(-100).reverse());
      }
      if (url.pathname === '/api/alerts') return send(200, store.list('alerts').slice(-50).reverse());

      return send(404, { error: 'not found' });
    } catch (err) {
      return send(500, { error: err.message });
    }
  });

  const ready = loadFlows(engine, flowsDir).then(() => engine.recoverInterrupted());
  return { server, engine, store, ready };
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
