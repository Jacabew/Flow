import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine, defaultRetries } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { makeDsosClient, dsosConfig, checkDsosPath } from '../src/connectors/dsos.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOKEN = 'tok-123-secret';

// A tiny stand-in for DSOS that records every request it gets.
async function fakeDsos(handler = (req, body) => ({ status: 200, body: { ok: true, path: req.url, body } })) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const out = await handler(req, body);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('dsos GET sends the Bearer token and query, returns parsed body', async () => {
  const d = await fakeDsos();
  try {
    const client = makeDsosClient({ env: { FLOW_DSOS_URL: d.url, FLOW_DSOS_TOKEN: TOKEN } });
    const out = await client.request({ path: '/api/v1/jobs', query: { status: 'open', skip: undefined } });
    assert.equal(out.status, 200);
    assert.equal(out.body.path, '/api/v1/jobs?status=open');
    assert.equal(d.seen[0].auth, `Bearer ${TOKEN}`);
  } finally { await d.close(); }
});

test('dsos writes are shadow unless the step is live AND FLOW_DSOS_WRITES=live', async () => {
  const d = await fakeDsos();
  try {
    const base = { FLOW_DSOS_URL: d.url, FLOW_DSOS_TOKEN: TOKEN };
    const req = { method: 'POST', path: '/api/v1/todos', body: { title: 'x' } };

    const notLive = await makeDsosClient({ env: { ...base, FLOW_DSOS_WRITES: 'live' } }).request(req);
    assert.equal(notLive.shadow, true);
    assert.deepEqual(notLive.wouldSend, { method: 'POST', path: '/api/v1/todos', query: null, body: { title: 'x' } });

    const envOff = await makeDsosClient({ env: base }).request({ ...req, live: true });
    assert.equal(envOff.shadow, true);
    assert.match(envOff.reason, /FLOW_DSOS_WRITES/);
    assert.equal(d.seen.length, 0, 'nothing reached DSOS in shadow mode');

    const live = await makeDsosClient({ env: { ...base, FLOW_DSOS_WRITES: 'live' } }).request({ ...req, live: true });
    assert.equal(live.live, true);
    assert.equal(d.seen.length, 1);
    assert.deepEqual(d.seen[0].body, { title: 'x' });
  } finally { await d.close(); }
});

test('dsos shadow writes work without a token (nothing is sent)', async () => {
  const out = await makeDsosClient({ env: {} }).request({ method: 'PATCH', path: '/api/v1/todos/7', body: { status: 'done' } });
  assert.equal(out.shadow, true);
});

test('dsos refuses paths that could leave /api/v1 or another host', () => {
  for (const bad of ['http://evil.example/api/v1/x', '//evil.example/api/v1/x', '/api/v2/jobs', '/api/v1/../admin',
    '/api/v1/jobs?x=1', '/api/v1/a b', 'api/v1/jobs', '/api/v1//x', '/api/v1/%2e%2e/admin', '/api/v1/x#y', null]) {
    assert.throws(() => checkDsosPath(bad), /DSOS path/, String(bad));
  }
  assert.equal(checkDsosPath('/api/v1/jobs/12/time'), '/api/v1/jobs/12/time');
});

test('dsos token comes from env or the secrets file; missing token is a clear error', async () => {
  const dir = tmp('dsflow-secrets-');
  assert.equal(dsosConfig({ FLOW_SECRETS_DIR: dir }).token, null);
  await assert.rejects(
    makeDsosClient({ env: { FLOW_SECRETS_DIR: dir } }).request({ path: '/api/v1/jobs' }),
    /not configured.*dsos-token\.txt/,
  );
  fs.writeFileSync(path.join(dir, 'dsos-token.txt'), `  ${TOKEN}\r\n`);
  const c = dsosConfig({ FLOW_SECRETS_DIR: dir });
  assert.equal(c.token, TOKEN);
  assert.equal(c.tokenSource, 'file');
  assert.equal(c.baseUrl, 'http://127.0.0.1:3000');
  assert.equal(dsosConfig({ FLOW_SECRETS_DIR: dir, FLOW_DSOS_TOKEN: 'envtok' }).tokenSource, 'env');
});

test('dsos errors never contain the token and hint at auth on 401', async () => {
  const d = await fakeDsos(() => ({ status: 401, body: { error: `bad token ${TOKEN}` } }));
  try {
    const client = makeDsosClient({ env: { FLOW_DSOS_URL: d.url, FLOW_DSOS_TOKEN: TOKEN } });
    await assert.rejects(client.request({ path: '/api/v1/jobs' }), (err) => {
      assert.match(err.message, /HTTP 401 \(check the DSOS token/);
      assert.ok(!err.message.includes(TOKEN));
      return true;
    });
  } finally { await d.close(); }
});

test('dsos step in a flow: reads pass, shadow writes are logged to the shadow collection', async () => {
  const d = await fakeDsos();
  try {
    const store = new Store(tmp('dsflow-'));
    const dsos = makeDsosClient({ env: { FLOW_DSOS_URL: d.url, FLOW_DSOS_TOKEN: TOKEN } });
    const engine = new Engine({ store, connectors: { dsos } });
    engine.register({
      id: 'dsos-demo',
      steps: [
        { type: 'dsos', name: 'jobs', path: '/api/v1/jobs', query: { status: 'open' } },
        { type: 'dsos', name: 'todo', method: 'POST', path: '/api/v1/todos', body: (c) => ({ from: c.steps.jobs.body.path }) },
      ],
    });
    const r = await engine.trigger('dsos-demo');
    assert.equal(r.status, 'success');
    const run = store.get('runs', r.runId);
    assert.equal(run.steps.todo.shadow, true);
    assert.equal(d.seen.length, 1, 'only the read reached DSOS');
    const shadow = store.list('shadow');
    assert.equal(shadow.length, 1);
    assert.equal(shadow[0].flowId, 'dsos-demo');
    assert.deepEqual(shadow[0].body, { from: '/api/v1/jobs?status=open' });
    assert.ok(!JSON.stringify(run).includes(TOKEN));
  } finally { await d.close(); }
});

test('dsos reads retry by default, writes do not', () => {
  assert.equal(defaultRetries({ type: 'dsos' }), 2);
  assert.equal(defaultRetries({ type: 'dsos', method: 'post' }), 0);
  assert.equal(defaultRetries({ type: 'http' }), 2);
  assert.equal(defaultRetries({ type: 'code' }), 0);
});

test('/api/connectors shows DSOS status without the token; /api/shadow lists shadow writes', async () => {
  const flowsDir = tmp('dsflow-flows-');
  fs.writeFileSync(path.join(flowsDir, 'w.js'),
    `export default { id: 'w', steps: [{ type: 'dsos', method: 'POST', path: '/api/v1/todos', body: { a: 1 } }] };`);
  const app = createApp({ dataDir: tmp('dsflow-'), apiKey: 'k', flowsDir, env: { FLOW_DSOS_TOKEN: TOKEN } });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const h = { 'x-api-key': 'k' };
  try {
    const conn = await (await fetch(`${base}/api/connectors`, { headers: h })).text();
    assert.ok(!conn.includes(TOKEN));
    assert.deepEqual(JSON.parse(conn).dsos, { baseUrl: 'http://127.0.0.1:3000', configured: true, tokenSource: 'env', writesLive: false });
    await fetch(`${base}/api/flows/w/run`, { method: 'POST', headers: h });
    const rows = await (await fetch(`${base}/api/shadow?flow=w`, { headers: h })).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, '/api/v1/todos');
  } finally { await new Promise((r) => app.server.close(r)); }
});
