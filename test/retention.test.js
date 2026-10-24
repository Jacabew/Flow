import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { archiveOldRuns, brisbaneMonth } from '../src/retention.js';
import retention from '../flows/retention.js';

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')));
const readArchive = (store, month) =>
  JSON.parse(fs.readFileSync(path.join(store.dir, 'archive', `runs-${month}.json`), 'utf8'));

test('brisbaneMonth uses UTC+10', () => {
  assert.equal(brisbaneMonth('2026-08-31T14:00:00Z'), '2026-09'); // 1 Sep 00:00 Brisbane
  assert.equal(brisbaneMonth('2026-08-31T13:59:00Z'), '2026-08');
});

test('archives old finished runs by month, keeps recent and live ones', () => {
  const store = tmpStore();
  store.insert('runs', { flowId: 'a', status: 'success', startedAt: '2026-08-10T00:00:00Z' });
  store.insert('runs', { flowId: 'a', status: 'failed', startedAt: '2026-08-31T14:30:00Z' }); // Sep in Brisbane
  store.insert('runs', { flowId: 'b', status: 'waiting_approval', startedAt: '2026-08-11T00:00:00Z' });
  store.insert('runs', { flowId: 'a', status: 'success', startedAt: '2026-10-20T00:00:00Z' });
  const r = archiveOldRuns(store, { now: new Date('2026-10-24T00:00:00Z') });
  assert.equal(r.archived, 2);
  assert.equal(r.files.length, 2);
  assert.equal(readArchive(store, '2026-08').length, 1);
  assert.equal(readArchive(store, '2026-09')[0].status, 'failed');
  const left = store.list('runs').map((x) => x.status).sort();
  assert.deepEqual(left, ['success', 'waiting_approval']);
  // Survives a reload from disk.
  assert.equal(new Store(store.dir).list('runs').length, 2);
});

test('appends to an existing month file without duplicates', () => {
  const store = tmpStore();
  const a = store.insert('runs', { flowId: 'a', status: 'success', startedAt: '2026-08-01T00:00:00Z' });
  archiveOldRuns(store, { now: new Date('2026-10-24T00:00:00Z') });
  // Simulate a crash after archiving but before removal: same run is back in the store.
  store.load('runs').push(a);
  store.insert('runs', { flowId: 'a', status: 'success', startedAt: '2026-08-02T00:00:00Z' });
  const r = archiveOldRuns(store, { now: new Date('2026-10-24T00:00:00Z') });
  assert.equal(r.archived, 2);
  const month = readArchive(store, '2026-08');
  assert.equal(month.length, 2);
  assert.equal(new Set(month.map((x) => x.id)).size, 2);
  assert.equal(store.list('runs').length, 0);
});

test('nothing to archive is a no-op', () => {
  const store = tmpStore();
  store.insert('runs', { flowId: 'a', status: 'success', startedAt: '2026-10-23T00:00:00Z' });
  assert.deepEqual(archiveOldRuns(store, { now: new Date('2026-10-24T00:00:00Z') }), { archived: 0, files: [] });
  assert.equal(fs.existsSync(path.join(store.dir, 'archive')), false);
});

test('retention flow archives via the engine', async () => {
  const store = tmpStore();
  store.insert('runs', { flowId: 'a', status: 'success', startedAt: '2026-01-01T00:00:00Z' });
  const engine = new Engine({ store, now: () => new Date('2026-10-23T14:20:00Z') });
  engine.register(retention);
  const r = await engine.trigger('retention');
  assert.equal(r.status, 'success');
  assert.deepEqual(store.get('runs', r.runId).steps.archive, { archived: 1, months: 1 });
});

test('restart recovery marks stuck running runs failed and alerts', async () => {
  const store = tmpStore();
  const stuck = store.insert('runs', { flowId: 'x', status: 'running', startedAt: '2026-10-23T00:00:00Z', stepIndex: 1, steps: {}, log: [] });
  const waiting = store.insert('runs', { flowId: 'y', status: 'waiting_approval', startedAt: '2026-10-23T00:00:00Z', stepIndex: 1, steps: {}, log: [] });
  const alerts = [];
  const engine = new Engine({ store: new Store(store.dir), alert: async (a) => alerts.push(a) });
  assert.deepEqual(await engine.recoverInterrupted(), { recovered: 1 });
  const run = engine.store.get('runs', stuck.id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /interrupted by a restart \(step 2\)/);
  assert.ok(run.finishedAt);
  assert.equal(engine.store.get('runs', waiting.id).status, 'waiting_approval');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].flowId, 'x');
  // Second call finds nothing.
  assert.deepEqual(await engine.recoverInterrupted(), { recovered: 0 });
});

test('restart recovery survives a failing alert', async () => {
  const store = tmpStore();
  store.insert('runs', { flowId: 'x', status: 'running', startedAt: '2026-10-23T00:00:00Z', stepIndex: 0, steps: {}, log: [] });
  const engine = new Engine({ store, alert: async () => { throw new Error('down'); } });
  assert.deepEqual(await engine.recoverInterrupted(), { recovered: 1 });
});
