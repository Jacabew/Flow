import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { makeDsosClient } from '../src/connectors/dsos.js';
import { parseSyncStatus, compareDay, weekReport, BACKFEED_COLLECTION } from '../src/backfeed.js';
import flow from '../flows/xero-backfeed-shadow.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOKEN = 'tok-backfeed';
// 08:30 Brisbane on 2026-11-02 = 22:30 UTC on 1 Nov
const morning = (day) => new Date(Date.parse(`${day}T08:30:00+10:00`));

async function fakeDsos(statusFor) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(statusFor()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('parseSyncStatus reads common shapes', () => {
  assert.deepEqual(parseSyncStatus({ lastRunAt: '2026-11-01T21:05:00Z', ok: true }),
    { lastRunAt: '2026-11-01T21:05:00.000Z', ok: true, error: null });
  assert.deepEqual(parseSyncStatus({ data: { last_synced_at: '2026-11-01T21:05:00Z', status: 'failed', last_error: 'token expired' } }),
    { lastRunAt: '2026-11-01T21:05:00.000Z', ok: false, error: 'token expired' });
  assert.deepEqual(parseSyncStatus({}), { lastRunAt: null, ok: null, error: null });
  assert.deepEqual(parseSyncStatus('not json'), { lastRunAt: null, ok: null, error: null });
  assert.equal(parseSyncStatus({ lastRunAt: 'garbage' }).lastRunAt, null);
});

test('compareDay uses the Brisbane day (UTC+10, no DST)', () => {
  const now = morning('2026-11-02');
  // 06:05 Brisbane on 2 Nov = 20:05 UTC on 1 Nov: still "today" in Brisbane
  assert.equal(compareDay({ now, status: { lastRunAt: '2026-11-01T20:05:00.000Z', ok: true } }).verdict, 'match');
  assert.equal(compareDay({ now, status: { lastRunAt: '2026-11-01T20:05:00.000Z', ok: null } }).verdict, 'match');
  assert.equal(compareDay({ now, status: { lastRunAt: '2026-11-01T20:05:00.000Z', ok: false } }).verdict, 'dsos-failed');
  // 06:05 Brisbane on 1 Nov: yesterday
  assert.equal(compareDay({ now, status: { lastRunAt: '2026-10-31T20:05:00.000Z', ok: true } }).verdict, 'dsos-missed');
  assert.equal(compareDay({ now, status: { lastRunAt: null, ok: null } }).verdict, 'no-data');
  assert.equal(compareDay({ now, status: { lastRunAt: null } }).day, '2026-11-02');
});

test('weekReport: 7 matches = ready; gaps count as flow-missed and break the streak', () => {
  const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  const all = days.map((day) => ({ day, verdict: 'match' }));
  const ready = weekReport(all, '2026-11-07');
  assert.equal(ready.readyToSwitch, true);
  assert.equal(ready.matched, 7);
  assert.equal(ready.streak, 7);
  assert.equal(ready.from, '2026-11-01');
  assert.match(ready.headline, /7\/7.*ready/);

  const gappy = weekReport(all.filter((e) => e.day !== '2026-11-04'), '2026-11-07');
  assert.equal(gappy.readyToSwitch, false);
  assert.equal(gappy.days[3].verdict, 'flow-missed');
  assert.equal(gappy.matched, 6);
  assert.equal(gappy.streak, 3);

  const failedToday = weekReport([...all.slice(0, 6), { day: '2026-11-07', verdict: 'dsos-failed' }], '2026-11-07');
  assert.equal(failedToday.streak, 0);
  assert.equal(failedToday.readyToSwitch, false);
});

test('flow stops quietly (success, no alert) when the DSOS token is not set yet', async () => {
  const alerts = [];
  const store = new Store(tmp('dsflow-bf-'));
  const engine = new Engine({ store, alert: async (a) => alerts.push(a), connectors: { dsos: makeDsosClient({ env: {} }) } });
  engine.register(flow);
  const r = await engine.trigger('xero-backfeed-shadow');
  assert.equal(r.status, 'success');
  assert.equal(alerts.length, 0);
  assert.equal(store.list('shadow').length, 0);
  assert.equal(store.list(BACKFEED_COLLECTION).length, 0);
});

test('flow reads DSOS status, shadows the sync (never sent, even with writes live), records one entry per day', async () => {
  let status = { lastRunAt: '2026-11-01T20:05:00Z', ok: true };
  const d = await fakeDsos(() => status);
  try {
    let clock = morning('2026-11-02');
    const store = new Store(tmp('dsflow-bf-'));
    const dsos = makeDsosClient({ env: { FLOW_DSOS_URL: d.url, FLOW_DSOS_TOKEN: TOKEN, FLOW_DSOS_WRITES: 'live' } });
    const engine = new Engine({ store, now: () => clock, connectors: { dsos } });
    engine.register(flow);

    const r1 = await engine.trigger('xero-backfeed-shadow');
    assert.equal(r1.status, 'success');
    assert.deepEqual(d.seen.map((s) => s.method), ['GET'], 'only the status read reached DSOS');
    assert.equal(d.seen[0].url, '/api/v1/xero/sync-status');
    const shadow = store.list('shadow');
    assert.equal(shadow.length, 1);
    assert.equal(shadow[0].path, '/api/v1/xero/sync');
    assert.equal(shadow[0].flowId, 'xero-backfeed-shadow');
    const run = store.get('runs', r1.runId);
    assert.equal(run.steps.compare.verdict, 'match');
    assert.equal(run.steps.week.matched, 1);

    // Manual re-run the same day replaces that day's entry
    status = { lastRunAt: '2026-11-01T20:05:00Z', ok: false, error: 'Xero 401' };
    await engine.trigger('xero-backfeed-shadow');
    const rows = store.list(BACKFEED_COLLECTION);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, 'dsos-failed');
    assert.equal(rows[0].dsosError, 'Xero 401');

    // Next day, DSOS didn't run
    clock = morning('2026-11-03');
    await engine.trigger('xero-backfeed-shadow');
    assert.equal(store.list(BACKFEED_COLLECTION).length, 2);
    assert.equal(store.list(BACKFEED_COLLECTION).at(-1).verdict, 'dsos-missed');
  } finally { await d.close(); }
});

test('GET /api/shadow/xero-backfeed returns the week report (auth required)', async () => {
  const dataDir = tmp('dsflow-bf-api-');
  const { server, store, ready } = createApp({ dataDir, apiKey: 'k', flowsDir: tmp('dsflow-noflows-'), env: {} });
  await ready;
  store.insert(BACKFEED_COLLECTION, { day: '2026-10-30', verdict: 'match' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/shadow/xero-backfeed`)).status, 401);
    const res = await fetch(`${base}/api/shadow/xero-backfeed`, { headers: { 'x-api-key': 'k' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.days.length, 7);
    assert.equal(typeof body.readyToSwitch, 'boolean');
    assert.ok(Array.isArray(body.recent));
  } finally { await new Promise((r) => server.close(r)); }
});
