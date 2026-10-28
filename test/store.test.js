import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-store-'));
const lineCount = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;

test('store: insert/update/remove survive a restart', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  const a = s.insert('runs', { n: 1, status: 'running' });
  const b = s.insert('runs', { n: 2 });
  s.insert('runs', { n: 3 });
  s.update('runs', a.id, { status: 'success' });
  s.remove('runs', (r) => r.id === b.id);

  const again = new Store(dir);
  const rows = again.list('runs');
  assert.deepEqual(rows.map((r) => r.n), [1, 3]); // order kept, update in place
  assert.equal(again.get('runs', a.id).status, 'success');
  assert.equal(again.get('runs', b.id), null);
});

test('store: an update appends one line, it does not rewrite the file', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  for (let i = 0; i < 50; i++) s.insert('runs', { i, pad: 'x'.repeat(200) });
  const f = path.join(dir, 'runs.jsonl');
  const before = fs.statSync(f).size;
  const row = s.list('runs')[0];
  s.update('runs', row.id, { status: 'success' });
  const grew = fs.statSync(f).size - before;
  assert.ok(grew > 0 && grew < 400, `grew ${grew} bytes`);
  assert.equal(lineCount(f), 51);
});

test('store: compacts when the log is mostly stale lines', () => {
  const dir = tmpDir();
  const s = new Store(dir, { compactSlack: 20 });
  const row = s.insert('runs', { n: 0 });
  for (let i = 1; i <= 100; i++) s.update('runs', row.id, { n: i });
  const f = path.join(dir, 'runs.jsonl');
  assert.ok(lineCount(f) <= 22, `log has ${lineCount(f)} lines`);
  assert.equal(new Store(dir).get('runs', row.id).n, 100);
  assert.equal(fs.existsSync(`${f}.tmp`), false);
});

test('store: trim drops oldest and persists', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  for (let i = 0; i < 10; i++) s.insert('alerts', { i });
  s.trim('alerts', 3);
  assert.deepEqual(new Store(dir).list('alerts').map((r) => r.i), [7, 8, 9]);
});

test('store: a torn last line (crash mid-write) is skipped, earlier rows kept', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.insert('runs', { n: 1 });
  s.insert('runs', { n: 2 });
  const f = path.join(dir, 'runs.jsonl');
  fs.appendFileSync(f, '{"put":{"id":"x","n":');
  const again = new Store(dir);
  assert.deepEqual(again.list('runs').map((r) => r.n), [1, 2]);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('runs.jsonl.corrupt-')));
  // Rewritten clean, so new appends start on a fresh line.
  again.insert('runs', { n: 3 });
  assert.deepEqual(new Store(dir).list('runs').map((r) => r.n), [1, 2, 3]);
});

test('store: imports an old runs.json once and renames it', () => {
  const dir = tmpDir();
  const old = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(old, null, 2));
  const s = new Store(dir);
  assert.deepEqual(s.list('runs'), old);
  assert.equal(fs.existsSync(path.join(dir, 'runs.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'runs.json.migrated')), true);
  s.update('runs', 'a', { n: 10 });
  assert.equal(new Store(dir).get('runs', 'a').n, 10);
});

test('store: a typical day of runs stays cheap to write', () => {
  // ~580 runs/day (heartbeat + watchdog), each inserted then updated a few times.
  const dir = tmpDir();
  const s = new Store(dir);
  const t0 = Date.now();
  for (let i = 0; i < 2000; i++) s.insert('runs', { flowId: 'heartbeat', status: 'success', steps: { a: { ok: true } }, log: ['x'.repeat(120)] });
  const r = s.list('runs')[0];
  const t1 = Date.now();
  for (let i = 0; i < 200; i++) s.update('runs', r.id, { stepIndex: i });
  assert.ok(Date.now() - t1 < 1000, 'updates should not scale with store size');
  assert.ok(t1 - t0 < 5000);
  assert.ok(s.sizeBytes('runs') > 0);
});
