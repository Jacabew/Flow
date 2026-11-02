import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { makeDsosClient } from '../src/connectors/dsos.js';
import { createApp } from '../src/app.js';
import { validateAgent, modeFor, actionOf, agentsReport } from '../src/agents.js';
import enquiryAgent from '../agents/enquiry-responder.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const agent = {
  id: 'helper',
  name: 'Helper',
  job: 'Test agent',
  actions: {
    'dsos:GET /api/v1/jobs*': 'auto',
    'dsos:POST /api/v1/todos': 'auto',
    'dsos:POST /api/v1/leads': 'approval',
    'http:GET api.example.com': 'auto',
  },
};

function setup({ writesLive = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const env = { FLOW_DSOS_TOKEN: 't', ...(writesLive ? { FLOW_DSOS_WRITES: 'live' } : {}) };
  const dsos = makeDsosClient({ env, fetchImpl });
  const alerts = [];
  const engine = new Engine({ store: new Store(tmp('dsflow-ag-')), connectors: { dsos }, alert: async (a) => alerts.push(a) });
  engine.registerAgent(agent);
  return { engine, calls, alerts };
}

test('validateAgent rejects bad ids, bad actions and bad modes', () => {
  assert.throws(() => validateAgent({ id: 'Bad Id', name: 'x', job: 'y' }), /id/);
  assert.throws(() => validateAgent({ id: 'a', job: 'y' }), /name and a job/);
  assert.throws(() => validateAgent({ id: 'a', name: 'x', job: 'y', actions: { 'dsos /api': 'auto' } }), /bad action/);
  assert.throws(() => validateAgent({ id: 'a', name: 'x', job: 'y', actions: { 'dsos:GET /x': 'yes' } }), /auto or approval/);
  assert.deepEqual(validateAgent(enquiryAgent).id, 'enquiry-responder');
});

test('modeFor: unlisted is denied, * matches, approval wins over auto', () => {
  const a = validateAgent({ id: 'a', name: 'A', job: 'j', actions: { 'dsos:GET /api/v1/*': 'auto', 'dsos:GET /api/v1/secret*': 'approval' } });
  assert.equal(modeFor(a, 'dsos:GET /api/v1/jobs/7'), 'auto');
  assert.equal(modeFor(a, 'dsos:GET /api/v1/secrets'), 'approval');
  assert.equal(modeFor(a, 'dsos:POST /api/v1/jobs'), 'denied');
  assert.equal(modeFor(a, 'http:GET evil.com'), 'denied');
  // Regex characters in patterns are literal.
  const b = validateAgent({ id: 'b', name: 'B', job: 'j', actions: { 'http:GET a.b.com': 'auto' } });
  assert.equal(modeFor(b, 'http:GET axb.com'), 'denied');
});

test('actionOf: dsos uses method + path, http uses method + host, internal steps are null', () => {
  assert.equal(actionOf({ type: 'dsos', path: '/api/v1/jobs' }, null), 'dsos:GET /api/v1/jobs');
  assert.equal(actionOf({ type: 'dsos', method: 'post', path: (c) => c.p }, { p: '/api/v1/x' }), 'dsos:POST /api/v1/x');
  assert.equal(actionOf({ type: 'dsos', path: () => '/x' }, null), undefined);
  assert.equal(actionOf({ type: 'http', url: 'https://api.example.com/v2?q=1' }, null), 'http:GET api.example.com');
  assert.equal(actionOf({ type: 'code', fn: () => 1 }, null), null);
});

test('a flow naming an unknown agent, or a fixed action its agent lacks, fails to load', () => {
  const { engine } = setup();
  assert.throws(() => engine.register({ id: 'f', agent: 'nobody', steps: [] }), /unknown agent/);
  assert.throws(
    () => engine.register({ id: 'f', agent: 'helper', steps: [{ type: 'dsos', method: 'DELETE', path: '/api/v1/jobs/1' }] }),
    /not allowed "dsos:DELETE \/api\/v1\/jobs\/1"/,
  );
  assert.throws(() => engine.registerAgent(agent), /twice/);
});

test('auto actions run without asking; flows without an agent are unrestricted', async () => {
  const { engine, calls } = setup();
  engine.register({ id: 'f', agent: 'helper', steps: [
    { type: 'dsos', path: '/api/v1/jobs/12' },
    { type: 'dsos', method: 'POST', path: '/api/v1/todos', body: { t: 1 }, live: true },
  ] });
  engine.register({ id: 'sys', steps: [{ type: 'dsos', method: 'POST', path: '/api/v1/anything', body: {}, live: true }] });
  assert.equal((await engine.trigger('f')).status, 'success');
  assert.equal((await engine.trigger('sys')).status, 'success');
  assert.deepEqual(calls, ['GET /api/v1/jobs/12', 'POST /api/v1/todos', 'POST /api/v1/anything']);
});

test('a dynamic action outside the agent list fails the run and alerts, nothing sent', async () => {
  const { engine, calls, alerts } = setup();
  engine.register({ id: 'f', agent: 'helper', steps: [{ type: 'dsos', method: 'POST', path: (c) => c.input.p, body: {}, live: true }] });
  const r = await engine.trigger('f', { p: '/api/v1/invoices' });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /agent helper is not allowed "dsos:POST \/api\/v1\/invoices"/);
  assert.equal(calls.length, 0);
  assert.equal(alerts.length, 1);
});

test('an approval action pauses before the step; approve runs it once, reject sends nothing', async () => {
  const { engine, calls } = setup();
  engine.register({ id: 'f', agent: 'helper', steps: [
    { type: 'code', name: 'prep', fn: () => ({ email: 'sam@example.com' }) },
    { type: 'dsos', name: 'lead', method: 'POST', path: '/api/v1/leads', body: (c) => c.steps.prep, live: true },
    { type: 'code', name: 'after', fn: (c) => c.steps.lead.live },
  ] });

  const r = await engine.trigger('f');
  assert.equal(r.status, 'waiting_approval');
  assert.equal(calls.length, 0, 'nothing sent before approval');
  const ap = engine.store.get('approvals', r.approvalId);
  assert.equal(ap.title, 'Helper: dsos:POST /api/v1/leads?');
  assert.deepEqual(ap.detail.body, { email: 'sam@example.com' });

  const done = await engine.decide(r.approvalId, 'approve');
  assert.equal(done.status, 'success');
  assert.deepEqual(calls, ['POST /api/v1/leads']);
  assert.equal(engine.store.get('runs', r.runId).steps.after, true);

  const r2 = await engine.trigger('f');
  assert.equal(r2.status, 'waiting_approval', 'approval is per run, not standing');
  assert.equal((await engine.decide(r2.approvalId, 'reject')).status, 'rejected');
  assert.equal(calls.length, 1);
});

test('shadow writes need no approval (nothing happens) but are still permission-checked', async () => {
  const { engine, calls } = setup({ writesLive: false });
  engine.register({ id: 'f', agent: 'helper', steps: [
    { type: 'dsos', name: 'lead', method: 'POST', path: '/api/v1/leads', body: {}, live: true },
  ] });
  const r = await engine.trigger('f');
  assert.equal(r.status, 'success');
  assert.equal(engine.store.get('runs', r.runId).steps.lead.shadow, true);
  assert.equal(calls.length, 0);
  assert.equal(engine.store.list('approvals').length, 0);
});

test('GET /api/agents lists agents with their flows, permissions and recent runs', async () => {
  const agentsDir = tmp('dsflow-agents-');
  const flowsDir = tmp('dsflow-agflows-');
  fs.writeFileSync(path.join(agentsDir, 'helper.js'), `export default ${JSON.stringify(agent)};`);
  fs.writeFileSync(path.join(flowsDir, 'f.js'), `export default { id: 'f', agent: 'helper', steps: [{ type: 'log', message: 'hi' }] };`);
  fs.writeFileSync(path.join(flowsDir, 'sys.js'), `export default { id: 'sys', steps: [] };`);
  const app = createApp({ dataDir: tmp('dsflow-'), apiKey: 'k', flowsDir, agentsDir, env: {} });
  await app.ready;
  await app.engine.trigger('f');
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/agents`)).status, 401);
    const [a] = await (await fetch(`${base}/api/agents`, { headers: { 'x-api-key': 'k' } })).json();
    assert.equal(a.id, 'helper');
    assert.deepEqual(a.flows, [{ id: 'f', enabled: true }]);
    assert.deepEqual(a.needsApproval, ['dsos:POST /api/v1/leads']);
    assert.equal(a.auto.length, 3);
    assert.equal(a.runs24h, 1);
    assert.equal(a.failed24h, 0);
  } finally { await new Promise((r) => app.server.close(r)); }
});

test('the real agents/ folder loads with the real flows/ folder', async () => {
  const app = createApp({ dataDir: tmp('dsflow-'), apiKey: 'k', flowsDir: path.resolve('flows'), agentsDir: path.resolve('agents'), env: {} });
  await app.ready;
  const rep = agentsReport(app.engine);
  const enq = rep.find((a) => a.id === 'enquiry-responder');
  assert.deepEqual(enq.flows.map((f) => f.id), ['enquiry-responder-shadow']);
});
