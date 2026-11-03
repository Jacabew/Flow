import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine, ALL_AGENTS } from '../src/engine.js';
import { makeDsosClient } from '../src/connectors/dsos.js';
import { createApp } from '../src/app.js';
import { validateAgent, isSendAction, brisbaneDay, usageToday, agentsReport, DEFAULT_LIMITS } from '../src/agents.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup({ limits, writesLive = true, clock } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return new Response('{}', { status: 200 });
  };
  const env = { FLOW_DSOS_TOKEN: 't', ...(writesLive ? { FLOW_DSOS_WRITES: 'live' } : {}) };
  const alerts = [];
  const t = clock ?? { now: new Date('2026-11-03T01:00:00Z') };
  const engine = new Engine({
    store: new Store(tmp('dsflow-gr-')),
    connectors: { dsos: makeDsosClient({ env, fetchImpl }) },
    alert: async (a) => alerts.push(a),
    now: () => t.now,
  });
  engine.registerAgent({
    id: 'helper', name: 'Helper', job: 'Test',
    actions: { 'dsos:GET /api/v1/*': 'auto', 'dsos:POST /api/v1/todos': 'auto', 'dsos:POST /api/v1/leads': 'approval' },
    ...(limits ? { limits } : {}),
  });
  engine.register({ id: 'todo', agent: 'helper', steps: [{ type: 'dsos', method: 'POST', path: '/api/v1/todos', body: {}, live: true }] });
  engine.register({ id: 'read', agent: 'helper', steps: [{ type: 'dsos', path: '/api/v1/jobs' }] });
  return { engine, calls, alerts, clock: t };
}

test('limits: validated, defaults applied, unknown keys and bad values rejected', () => {
  assert.deepEqual(validateAgent({ id: 'a', name: 'A', job: 'j' }).limits, DEFAULT_LIMITS);
  assert.deepEqual(validateAgent({ id: 'a', name: 'A', job: 'j', limits: { sendsPerDay: 3 } }).limits, { sendsPerDay: 3, spendPerDayAud: 0 });
  assert.throws(() => validateAgent({ id: 'a', name: 'A', job: 'j', limits: { emails: 3 } }), /unknown limit/);
  assert.throws(() => validateAgent({ id: 'a', name: 'A', job: 'j', limits: { sendsPerDay: -1 } }), /≥ 0/);
  assert.throws(() => validateAgent({ id: 'pause-all', name: 'A', job: 'j' }), /reserved/);
});

test('isSendAction: writes and sends count, reads do not; days are Brisbane days', () => {
  assert.equal(isSendAction('dsos:POST /api/v1/leads'), true);
  assert.equal(isSendAction('email:SEND sam@example.com'), true);
  assert.equal(isSendAction('dsos:GET /api/v1/jobs'), false);
  assert.equal(isSendAction('http:HEAD a.com'), false);
  assert.equal(brisbaneDay(new Date('2026-11-03T13:59:00Z')), '2026-11-03');
  assert.equal(brisbaneDay(new Date('2026-11-03T14:00:00Z')), '2026-11-04'); // midnight Brisbane
});

test('daily send limit: the step over the limit fails with an alert and is not sent; next Brisbane day resets', async () => {
  const { engine, calls, alerts, clock } = setup({ limits: { sendsPerDay: 2 } });
  assert.equal((await engine.trigger('todo')).status, 'success');
  assert.equal((await engine.trigger('todo')).status, 'success');
  for (let i = 0; i < 5; i++) await engine.trigger('read'); // reads don't count
  const r = await engine.trigger('todo');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /daily send limit reached \(2\/2\)/);
  assert.equal(calls.filter((c) => c.startsWith('POST')).length, 2);
  assert.equal(alerts.length, 1);
  assert.equal(usageToday(engine.store, 'helper', clock.now).sends, 2);

  clock.now = new Date('2026-11-03T14:00:00Z'); // 00:00 Brisbane next day
  assert.equal((await engine.trigger('todo')).status, 'success');
});

test('shadow writes never count against the send limit', async () => {
  const { engine, calls } = setup({ limits: { sendsPerDay: 1 }, writesLive: false });
  for (let i = 0; i < 3; i++) assert.equal((await engine.trigger('todo')).status, 'success');
  assert.equal(calls.length, 0);
  assert.equal(engine.store.list('agent_usage').length, 0);
});

test('spend limit: default $0 blocks any declared spend; a set limit allows up to it', async () => {
  const { engine, calls } = setup();
  engine.register({ id: 'paid', agent: 'helper', steps: [{ type: 'dsos', path: '/api/v1/jobs', spendAud: (c) => c.input.cost }] });
  const r = await engine.trigger('paid', { cost: 0.5 });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /daily spend limit reached/);
  assert.equal(calls.length, 0);

  const b = setup({ limits: { spendPerDayAud: 1 } });
  b.engine.register({ id: 'paid', agent: 'helper', steps: [{ type: 'dsos', path: '/api/v1/jobs', spendAud: 0.4 }] });
  assert.equal((await b.engine.trigger('paid')).status, 'success');
  assert.equal((await b.engine.trigger('paid')).status, 'success');
  assert.equal((await b.engine.trigger('paid')).status, 'failed'); // 0.8 + 0.4 > 1
  assert.equal(usageToday(b.engine.store, 'helper', b.clock.now).spendAud, 0.8);
});

test('limit is checked before asking for approval, so Jake is not asked for something that would be blocked', async () => {
  const { engine } = setup({ limits: { sendsPerDay: 1 } });
  await engine.trigger('todo');
  engine.register({ id: 'lead', agent: 'helper', steps: [{ type: 'dsos', method: 'POST', path: '/api/v1/leads', body: {}, live: true }] });
  const r = await engine.trigger('lead');
  assert.equal(r.status, 'failed');
  assert.equal(engine.store.list('approvals').length, 0);
});

test('pause one agent: new runs skipped, a run waiting on approval holds, resume carries it on', async () => {
  const { engine, calls } = setup();
  engine.register({ id: 'lead', agent: 'helper', steps: [
    { type: 'dsos', name: 'lead', method: 'POST', path: '/api/v1/leads', body: {}, live: true },
    { type: 'dsos', name: 'todo', method: 'POST', path: '/api/v1/todos', body: {}, live: true },
  ] });
  const r = await engine.trigger('lead');
  assert.equal(r.status, 'waiting_approval');

  assert.equal(await engine.setAgentPaused('helper', true), true);
  assert.equal(await engine.setAgentPaused('nobody', true), false);
  assert.deepEqual(await engine.trigger('todo'), { skipped: true, reason: 'agent is paused' });

  const held = await engine.decide(r.approvalId, 'approve');
  assert.equal(held.status, 'paused');
  assert.equal(calls.length, 0, 'nothing sent while paused');
  assert.equal(engine.summary().status, 'amber');
  assert.equal(engine.summary().headline, 'Automations: 1 agent paused');

  await engine.setAgentPaused('helper', false);
  assert.equal(engine.store.get('runs', r.runId).status, 'success');
  assert.deepEqual(calls, ['POST /api/v1/leads', 'POST /api/v1/todos']);
});

test('pause all: every agent stops, system flows keep running; resuming one agent does not override it', async () => {
  const { engine } = setup();
  engine.register({ id: 'sys', steps: [{ type: 'log', message: 'beat' }] });
  await engine.setAgentPaused(ALL_AGENTS, true);
  assert.equal((await engine.trigger('read')).skipped, true);
  assert.equal((await engine.trigger('sys')).status, 'success');
  await engine.setAgentPaused('helper', false);
  assert.equal(engine.isAgentPaused('helper'), true);
  const s = engine.summary();
  assert.equal(s.allAgentsPaused, true);
  assert.deepEqual(s.pausedAgents, ['helper']);
  assert.equal(s.headline, 'Automations: all agents paused');
  await engine.setAgentPaused(ALL_AGENTS, false);
  assert.equal((await engine.trigger('read')).status, 'success');
});

test('API: pause-all / resume-all and per-agent pause; /api/agents shows paused, limits and today', async () => {
  const agentsDir = tmp('dsflow-gra-');
  const flowsDir = tmp('dsflow-grf-');
  fs.writeFileSync(path.join(agentsDir, 'helper.js'), `export default { id: 'helper', name: 'H', job: 'j', limits: { sendsPerDay: 5 } };`);
  fs.writeFileSync(path.join(flowsDir, 'f.js'), `export default { id: 'f', agent: 'helper', steps: [{ type: 'log', message: 'hi' }] };`);
  const app = createApp({ dataDir: tmp('dsflow-'), apiKey: 'k', flowsDir, agentsDir, env: {} });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, key = 'k') => fetch(base + p, { method: 'POST', headers: { 'x-api-key': key } });
  try {
    assert.equal((await post('/api/agents/pause-all', 'wrong')).status, 401);
    assert.deepEqual(await (await post('/api/agents/pause-all')).json(), { ok: true, allAgentsPaused: true });
    assert.equal((await (await fetch(`${base}/api/summary`, { headers: { 'x-api-key': 'k' } })).json()).allAgentsPaused, true);
    assert.deepEqual(await (await post('/api/agents/resume-all')).json(), { ok: true, allAgentsPaused: false });
    assert.equal((await post('/api/agents/nobody/pause')).status, 404);
    assert.deepEqual(await (await post('/api/agents/helper/pause')).json(), { ok: true, paused: true });
    const [a] = await (await fetch(`${base}/api/agents`, { headers: { 'x-api-key': 'k' } })).json();
    assert.equal(a.paused, true);
    assert.deepEqual(a.limits, { sendsPerDay: 5, spendPerDayAud: 0 });
    assert.deepEqual(Object.keys(a.today), ['day', 'sends', 'spendAud']);
    assert.equal((await post('/api/agents/helper/resume')).status, 200);
    assert.equal(agentsReport(app.engine)[0].paused, false);
  } finally { await new Promise((r) => app.server.close(r)); }
});
