import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { checkHeartbeat, shouldAlert } from '../src/watchdog.js';
import heartbeat from '../flows/heartbeat.js';
import watchdog from '../flows/watchdog.js';

const T0 = Date.parse('2026-10-23T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000);
const beat = (min, status = 'success') => ({ flowId: 'heartbeat', status, startedAt: at(min).toISOString(), finishedAt: at(min).toISOString() });

test('checkHeartbeat: recent success is fine', () => {
  const c = checkHeartbeat({ runs: [beat(0), beat(5)], now: at(20), engineStartedAt: at(-60).toISOString() });
  assert.equal(c.stale, false);
  assert.equal(c.ageMin, 15);
});

test('checkHeartbeat: stale after 15 min, failed beats do not count', () => {
  const c = checkHeartbeat({ runs: [beat(0), beat(10, 'failed')], now: at(16), engineStartedAt: at(-60).toISOString() });
  assert.equal(c.stale, true);
  assert.equal(c.lastSuccessAt, at(0).toISOString());
});

test('checkHeartbeat: no beats ever is stale, except during start-up grace', () => {
  assert.equal(checkHeartbeat({ runs: [], now: at(20), engineStartedAt: at(0).toISOString() }).stale, true);
  assert.equal(checkHeartbeat({ runs: [], now: at(10), engineStartedAt: at(0).toISOString() }).stale, false);
  // Restart after a long outage: old beat, but just started → grace.
  assert.equal(checkHeartbeat({ runs: [beat(0)], now: at(120), engineStartedAt: at(115).toISOString() }).stale, false);
});

test('shouldAlert: once per outage', () => {
  assert.equal(shouldAlert({ stale: true }, undefined), true);
  assert.equal(shouldAlert({ stale: true }, { stale: false }), true);
  assert.equal(shouldAlert({ stale: true }, { stale: true }), false);
  assert.equal(shouldAlert({ stale: false }, { stale: true }), false);
});

test('watchdog flow: alerts once when heartbeat stops, then recovers', async () => {
  let clock = at(-60);
  const alerts = [];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')));
  const engine = new Engine({ store, now: () => clock, alert: async (a) => alerts.push(a) });
  engine.register(heartbeat);
  engine.register(watchdog);

  clock = at(0);
  await engine.trigger('heartbeat');
  clock = at(5);
  assert.equal((await engine.trigger('watchdog')).status, 'success');

  clock = at(20); // heartbeat silent for 20 min
  const r1 = await engine.trigger('watchdog');
  assert.equal(r1.status, 'failed');
  assert.match(r1.error, /Heartbeat stale/);
  assert.equal(alerts.length, 1);

  clock = at(25); // still down: no repeat alert
  assert.equal((await engine.trigger('watchdog')).status, 'success');
  assert.equal(alerts.length, 1);

  clock = at(26);
  await engine.trigger('heartbeat');
  clock = at(30);
  const r3 = await engine.trigger('watchdog');
  assert.equal(store.get('runs', r3.runId).steps.check.recovered, true);
  assert.equal(alerts.length, 1);
});
