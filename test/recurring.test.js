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
import {
  parseSchedules, predictDay, verifyDay, windowReport, toDay, toCents, RECURRING_COLLECTION, WINDOW_DAYS,
} from '../src/recurring.js';
import flow from '../flows/recurring-invoices-shadow.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const evening = (day) => new Date(Date.parse(`${day}T21:15:00+10:00`));

const rent = (over = {}) => ({ id: 'rs1', description: 'Workshop rent', active: true, nextRunOn: '2026-11-01', amountExGst: 1500, recentRuns: [], ...over });

test('toDay and toCents', () => {
  assert.equal(toDay('2026-11-01'), '2026-11-01');
  assert.equal(toDay('2026-10-31T20:05:00Z'), '2026-11-01', 'Brisbane day, UTC+10');
  assert.equal(toDay('nope'), null);
  assert.equal(toDay(null), null);
  assert.equal(toCents('1500.005'), 150001);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents('x'), null);
  assert.equal(toCents(undefined), null);
});

test('parseSchedules reads common shapes and skips junk', () => {
  const [a] = parseSchedules([rent({ recentRuns: [{ date: '2026-10-01', invoiceId: 'i9', invoiceNumber: 'INV-0101', totalExGst: '1500.00' }] })]);
  assert.deepEqual(a, {
    id: 'rs1', description: 'Workshop rent', active: true, nextRunOn: '2026-11-01', cents: 150000,
    runs: [{ day: '2026-10-01', invoiceId: 'i9', number: 'INV-0101', cents: 150000 }],
  });
  const [b] = parseSchedules({ data: [{ schedule_id: 7, name: 'Rent', status: 'paused', next_run_date: '2026-11-01T00:00:00+10:00', last_generated_on: '2026-10-01', lastAmountExGst: 1500 }] });
  assert.equal(b.id, '7');
  assert.equal(b.active, false);
  assert.equal(b.nextRunOn, '2026-11-01');
  assert.deepEqual(b.runs, [{ day: '2026-10-01', invoiceId: null, number: null, cents: 150000 }]);
  assert.deepEqual(parseSchedules('not json'), []);
  assert.deepEqual(parseSchedules({ data: 'x' }), []);
  assert.deepEqual(parseSchedules([null, 3, { description: 'no id' }]), []);
});

test('predictDay: active schedules whose DSOS next-run date is that day', () => {
  const s = parseSchedules([rent(), rent({ id: 'rs2', active: false }), rent({ id: 'rs3', nextRunOn: '2026-11-02' })]);
  assert.deepEqual(predictDay(s, '2026-11-01'), [{ scheduleId: 'rs1', description: 'Workshop rent', cents: 150000 }]);
  assert.deepEqual(predictDay(s, '2026-11-05'), []);
});

test('verifyDay: match, amount-differs, dsos-missed, unexpected, quiet', () => {
  const day = '2026-11-01';
  const predicted = [{ scheduleId: 'rs1', description: 'Workshop rent', cents: 150000 }];
  const ran = (cents) => parseSchedules([rent({ nextRunOn: '2026-12-01', recentRuns: [{ date: day, invoiceId: 'i1', number: 'INV-1', totalExGst: cents }] })]);

  const ok = verifyDay(predicted, ran(1500), day);
  assert.equal(ok.verdict, 'match');
  assert.equal(ok.items[0].invoiceId, 'i1');

  const diff = verifyDay(predicted, ran(1650), day);
  assert.equal(diff.verdict, 'mismatch');
  assert.equal(diff.items[0].verdict, 'amount-differs');
  assert.equal(diff.items[0].generatedCents, 165000);

  const missed = verifyDay(predicted, parseSchedules([rent()]), day);
  assert.equal(missed.items[0].verdict, 'dsos-missed');
  assert.equal(missed.verdict, 'mismatch');

  const surprise = verifyDay([], ran(1500), day);
  assert.equal(surprise.items[0].verdict, 'unexpected');
  assert.equal(surprise.verdict, 'mismatch');

  assert.deepEqual(verifyDay([], parseSchedules([rent()]), day), { items: [], verdict: 'quiet' });
  // Amount unknown on either side: generation alone is a match
  assert.equal(verifyDay([{ ...predicted[0], cents: null }], ran(1650), day).verdict, 'match');
});

test('windowReport: needs 31 clean checked days and at least one matched invoice', () => {
  const end = '2026-12-01';
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) =>
    new Date(Date.parse(`${end}T00:00:00Z`) - (WINDOW_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const quiet = days.map((day) => ({ day, verdict: 'quiet', items: [] }));
  assert.equal(windowReport(quiet, end).readyToSwitch, false, 'nothing matched yet');

  const withRent = quiet.map((e) => e.day === '2026-11-01'
    ? { day: e.day, verdict: 'match', items: [{ verdict: 'match', generated: true }] } : e);
  const r = windowReport(withRent, end);
  assert.equal(r.readyToSwitch, true);
  assert.equal(r.cleanDays, 31);
  assert.equal(r.matchedInvoices, 1);
  assert.equal(r.days.find((d) => d.day === '2026-11-01').invoices, 1);
  assert.match(r.headline, /31\/31.*ready/);

  const gap = windowReport(withRent.filter((e) => e.day !== '2026-11-15'), end);
  assert.equal(gap.readyToSwitch, false);
  assert.equal(gap.days.find((d) => d.day === '2026-11-15').verdict, 'flow-missed');

  const bad = windowReport(withRent.map((e) => e.day === '2026-11-20' ? { ...e, verdict: 'mismatch' } : e), end);
  assert.equal(bad.readyToSwitch, false);
  assert.deepEqual(bad.mismatchDays, ['2026-11-20']);
  assert.match(bad.headline, /1 mismatch/);
});

async function fakeDsos(bodyFor) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(bodyFor()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('flow stops quietly (success, no alert, nothing stored) when the DSOS token is not set yet', async () => {
  const alerts = [];
  const store = new Store(tmp('dsflow-rec-'));
  const engine = new Engine({ store, alert: async (a) => alerts.push(a), connectors: { dsos: makeDsosClient({ env: {} }) } });
  engine.register(flow);
  const r = await engine.trigger('recurring-invoices-shadow');
  assert.equal(r.status, 'success');
  assert.equal(alerts.length, 0);
  assert.equal(store.list('shadow').length, 0);
  assert.equal(store.list(RECURRING_COLLECTION).length, 0);
});

test('flow predicts tomorrow, shadows the generate call (never sent, even with writes live), verifies next day', async () => {
  let schedules = [rent()]; // DSOS says rent runs 1 Nov
  const d = await fakeDsos(() => ({ data: schedules }));
  try {
    let clock = evening('2026-10-31');
    const store = new Store(tmp('dsflow-rec-'));
    const dsos = makeDsosClient({ env: { FLOW_DSOS_URL: d.url, FLOW_DSOS_TOKEN: 'tok-rec', FLOW_DSOS_WRITES: 'live' } });
    const engine = new Engine({ store, now: () => clock, connectors: { dsos } });
    engine.register(flow);

    // 31 Oct evening: rent due tomorrow → shadow logged, nothing sent
    const r1 = await engine.trigger('recurring-invoices-shadow');
    assert.equal(r1.status, 'success');
    assert.deepEqual(d.seen.map((s) => `${s.method} ${s.url}`), ['GET /api/v1/recurring-invoices']);
    const shadow = store.list('shadow');
    assert.equal(shadow.length, 1);
    assert.equal(shadow[0].path, '/api/v1/recurring-invoices/generate-due');
    assert.deepEqual(shadow[0].body, { source: 'ds-flow', day: '2026-11-01', scheduleIds: ['rs1'] });
    const run1 = store.get('runs', r1.runId);
    assert.equal(run1.steps.check.yesterday.verdict, 'flow-missed', 'no prediction existed for 30 Oct');
    assert.deepEqual(run1.steps.check.tomorrow.predicted, [{ scheduleId: 'rs1', description: 'Workshop rent', cents: 150000 }]);

    // 1 Nov: DSOS generates the rent invoice and moves the next run on
    schedules = [rent({ nextRunOn: '2026-12-01', recentRuns: [{ date: '2026-11-01', invoiceId: 'i1', number: 'INV-0201', totalExGst: 1500 }] })];
    clock = evening('2026-11-01');
    const r2 = await engine.trigger('recurring-invoices-shadow');
    assert.equal(r2.status, 'success');
    assert.equal(store.list('shadow').length, 1, 'nothing due tomorrow, nothing shadowed');
    assert.equal(store.get('runs', r2.runId).steps.check.yesterday.verdict, 'flow-missed', 'no prediction was made for 31 Oct');

    // 2 Nov evening: verifies 1 Nov = match
    clock = evening('2026-11-02');
    await engine.trigger('recurring-invoices-shadow');
    const nov1 = store.list(RECURRING_COLLECTION, (e) => e.day === '2026-11-01').at(-1);
    assert.equal(nov1.verdict, 'match');
    assert.equal(nov1.items[0].number, 'INV-0201');
    assert.equal(store.list(RECURRING_COLLECTION, (e) => e.day === '2026-11-01').length, 1, 'one row per day');
    assert.ok(d.seen.every((s) => s.method === 'GET'), 'no write ever reached DSOS');
  } finally { await d.close(); }
});

test('flow records a missed rent invoice as a mismatch (no alert during shadow)', async () => {
  const alerts = [];
  const d = await fakeDsos(() => [rent()]); // DSOS never generates
  try {
    let clock = evening('2026-10-31');
    const store = new Store(tmp('dsflow-rec-'));
    const dsos = makeDsosClient({ env: { FLOW_DSOS_URL: d.url, FLOW_DSOS_TOKEN: 'tok-rec' } });
    const engine = new Engine({ store, alert: async (a) => alerts.push(a), now: () => clock, connectors: { dsos } });
    engine.register(flow);
    await engine.trigger('recurring-invoices-shadow');
    clock = evening('2026-11-02');
    await engine.trigger('recurring-invoices-shadow');
    const nov1 = store.list(RECURRING_COLLECTION, (e) => e.day === '2026-11-01').at(-1);
    assert.equal(nov1.verdict, 'mismatch');
    assert.equal(nov1.items[0].verdict, 'dsos-missed');
    assert.equal(alerts.length, 0);
  } finally { await d.close(); }
});

test('GET /api/shadow/recurring-invoices returns the 31-day report (auth required)', async () => {
  const { server, store, ready } = createApp({ dataDir: tmp('dsflow-rec-api-'), apiKey: 'k', flowsDir: tmp('dsflow-noflows-'), env: {} });
  await ready;
  store.insert(RECURRING_COLLECTION, { day: '2099-01-01', predicted: [{ scheduleId: 'rs1', description: 'Workshop rent', cents: 150000 }] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/shadow/recurring-invoices`)).status, 401);
    const res = await fetch(`${base}/api/shadow/recurring-invoices`, { headers: { 'x-api-key': 'k' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.days.length, 31);
    assert.equal(body.readyToSwitch, false);
    assert.equal(body.upcoming.length, 1);
    assert.ok(Array.isArray(body.recentMismatches));
  } finally { await new Promise((r) => server.close(r)); }
});
