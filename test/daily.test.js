import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { brisbaneDate, summariseDay } from '../src/daily.js';
import daily from '../flows/daily-summary.js';

test('brisbaneDate uses UTC+10', () => {
  // 15:00 UTC on 22 Oct = 01:00 on 23 Oct in Brisbane.
  assert.equal(brisbaneDate(new Date('2026-10-22T15:00:00Z')), '2026-10-23');
  assert.equal(brisbaneDate(new Date('2026-10-22T15:00:00Z'), -1), '2026-10-22');
});

test('summariseDay counts only that Brisbane day', () => {
  const runs = [
    { id: 'a', flowId: 'hb', status: 'success', startedAt: '2026-10-21T13:59:00Z' }, // 21 Oct 23:59 Bris — excluded
    { id: 'b', flowId: 'hb', status: 'success', startedAt: '2026-10-21T14:00:00Z' }, // 22 Oct 00:00 Bris
    { id: 'c', flowId: 'x', status: 'failed', error: 'boom', startedAt: '2026-10-22T05:00:00Z' },
    { id: 'd', flowId: 'x', status: 'waiting_approval', startedAt: '2026-10-22T13:59:00Z' },
    { id: 'e', flowId: 'hb', status: 'success', startedAt: '2026-10-22T14:00:00Z' }, // 23 Oct — excluded
  ];
  const s = summariseDay({ runs, alerts: [{ at: '2026-10-22T05:00:01Z' }], day: '2026-10-22' });
  assert.equal(s.runs, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.ok, false);
  assert.equal(s.alerts, 1);
  assert.deepEqual(s.byFlow.hb, { runs: 1, success: 1, failed: 0, other: 0 });
  assert.deepEqual(s.byFlow.x, { runs: 2, success: 0, failed: 1, other: 1 });
  assert.equal(s.failures[0].error, 'boom');
});

test('daily-summary flow writes daily.json for yesterday', async () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-status-'));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')));
  store.insert('runs', { flowId: 'hb', status: 'success', startedAt: '2026-10-22T02:00:00Z' });
  const engine = new Engine({ store, now: () => new Date('2026-10-22T14:10:00Z') }); // 00:10 23 Oct Bris
  engine.register(daily);
  const r = await engine.trigger('daily-summary', { statusDir });
  assert.equal(r.status, 'success');
  const out = JSON.parse(fs.readFileSync(path.join(statusDir, 'daily.json'), 'utf8'));
  assert.equal(out.day, '2026-10-22');
  assert.equal(out.runs, 1);
  assert.equal(out.ok, true);
});

test('daily-summary flow is a no-op without a status dir', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')));
  const engine = new Engine({ store });
  engine.register(daily);
  const saved = process.env.FLOW_STATUS_DIR;
  delete process.env.FLOW_STATUS_DIR;
  const r = await engine.trigger('daily-summary');
  if (saved !== undefined) process.env.FLOW_STATUS_DIR = saved;
  assert.equal(r.status, 'success');
  assert.equal(store.get('runs', r.runId).steps.write.written, false);
});
