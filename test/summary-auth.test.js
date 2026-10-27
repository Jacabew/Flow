import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createApp, AUTH_MAX_FAILS, AUTH_WINDOW_MS } from '../src/app.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NOW = new Date('2026-10-27T00:00:00Z');

function engineWith() {
  const engine = new Engine({ store: new Store(tmp('dsflow-sum-')), now: () => NOW });
  engine.register({ id: 'good', steps: [{ type: 'code', name: 'a', fn: () => 1 }] });
  engine.register({ id: 'bad', steps: [{ type: 'code', name: 'a', fn: () => { throw new Error('boom'); } }] });
  engine.register({ id: 'ask', steps: [{ type: 'approval', name: 'ok?', title: 'OK?' }] });
  return engine;
}

test('summary schema 1: exact frozen key set, green when nothing wrong', async () => {
  const engine = engineWith();
  await engine.trigger('good');
  const s = engine.summary();
  assert.deepEqual(Object.keys(s), [
    'schema', 'generatedAt', 'sinceHours', 'ok', 'status', 'headline', 'runs', 'failed',
    'failedFlows', 'lastFailureAt', 'pendingApprovals', 'flows',
  ]);
  assert.equal(s.schema, 1);
  assert.equal(s.generatedAt, NOW.toISOString());
  assert.equal(s.sinceHours, 24);
  assert.equal(s.status, 'green');
  assert.equal(s.headline, 'Automations: all green');
  assert.deepEqual(s.failedFlows, []);
  assert.equal(s.lastFailureAt, null);
});

test('summary: amber with a pending approval, red (and wins) with a failure', async () => {
  const engine = engineWith();
  await engine.trigger('ask');
  let s = engine.summary();
  assert.equal(s.status, 'amber');
  assert.equal(s.headline, 'Automations: 1 waiting for approval');
  assert.equal(s.ok, true);
  await engine.trigger('bad');
  await engine.trigger('bad');
  s = engine.summary();
  assert.equal(s.status, 'red');
  assert.equal(s.ok, false);
  assert.equal(s.headline, 'Automations: 2 failed');
  assert.deepEqual(s.failedFlows, ['bad']);
  assert.equal(s.lastFailureAt, NOW.toISOString());
  assert.equal(s.pendingApprovals, 1);
});

async function start(now) {
  const app = createApp({ dataDir: tmp('dsflow-'), apiKey: 'right-key', flowsDir: tmp('dsflow-flows-'), now });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, close: () => new Promise((r) => app.server.close(r)) };
}

test('bad keys lock that client out for the window; other clients unaffected', async () => {
  let t = 1_000_000;
  const app = await start(() => t);
  const get = (key, ip) => fetch(`${app.base}/api/summary`, {
    headers: { 'x-api-key': key, ...(ip ? { 'x-forwarded-for': ip } : {}) },
  });
  try {
    for (let i = 0; i < AUTH_MAX_FAILS; i++) assert.equal((await get('wrong', '1.1.1.1')).status, 401);
    assert.equal((await get('right-key', '1.1.1.1')).status, 429, 'locked even with the right key');
    // Forged earlier XFF entries don't dodge the lock: the last (proxy-added) entry counts.
    assert.equal((await get('right-key', '9.9.9.9, 1.1.1.1')).status, 429);
    assert.equal((await get('right-key', '2.2.2.2')).status, 200, 'other client fine');
    t += AUTH_WINDOW_MS;
    assert.equal((await get('right-key', '1.1.1.1')).status, 200, 'unlocked after window');
  } finally { await app.close(); }
});

test('wrong-length and missing keys are rejected', async () => {
  const app = await start();
  try {
    assert.equal((await fetch(`${app.base}/api/summary`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/summary`, { headers: { 'x-api-key': 'right-key-plus' } })).status, 401);
    assert.equal((await fetch(`${app.base}/api/summary`, { headers: { 'x-api-key': 'right-key' } })).status, 200);
  } finally { await app.close(); }
});
