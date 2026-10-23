import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { isDue } from '../src/scheduler.js';

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')));

test('runs steps in order and passes outputs forward', async () => {
  const engine = new Engine({ store: tmpStore() });
  engine.register({
    id: 'math',
    steps: [
      { type: 'code', name: 'a', fn: () => 2 },
      { type: 'code', name: 'b', fn: (ctx) => ctx.steps.a * 21 },
    ],
  });
  const r = await engine.trigger('math');
  assert.equal(r.status, 'success');
  assert.equal(engine.store.get('runs', r.runId).steps.b, 42);
});

test('retries a failing step, then succeeds', async () => {
  const engine = new Engine({ store: tmpStore() });
  let calls = 0;
  engine.register({
    id: 'flaky',
    steps: [{ type: 'code', name: 'x', retries: 2, retryDelayMs: 1, fn: () => { if (++calls < 3) throw new Error('boom'); return 'ok'; } }],
  });
  const r = await engine.trigger('flaky');
  assert.equal(r.status, 'success');
  assert.equal(calls, 3);
});

test('a failed run is logged and raises an alert', async () => {
  const alerts = [];
  const engine = new Engine({ store: tmpStore(), alert: async (a) => alerts.push(a) });
  engine.register({ id: 'bad', steps: [{ type: 'code', name: 'x', fn: () => { throw new Error('nope'); } }] });
  const r = await engine.trigger('bad');
  assert.equal(r.status, 'failed');
  assert.match(engine.store.get('runs', r.runId).error, /nope/);
  assert.equal(alerts.length, 1);
  assert.equal(engine.summary().ok, false);
});

test('an alert that throws does not crash the engine', async () => {
  const engine = new Engine({ store: tmpStore(), alert: async () => { throw new Error('alert down'); } });
  engine.register({ id: 'bad', steps: [{ type: 'code', fn: () => { throw new Error('nope'); } }] });
  const r = await engine.trigger('bad');
  assert.equal(r.status, 'failed');
});

test('approval pauses the run, approve resumes it', async () => {
  const engine = new Engine({ store: tmpStore() });
  let sent = false;
  engine.register({
    id: 'send',
    steps: [
      { type: 'approval', name: 'ok?', title: 'Send email?' },
      { type: 'code', name: 'send', fn: () => { sent = true; return 'sent'; } },
    ],
  });
  const r = await engine.trigger('send');
  assert.equal(r.status, 'waiting_approval');
  assert.equal(sent, false);
  assert.equal(engine.summary().pendingApprovals, 1);
  const done = await engine.decide(r.approvalId, 'approve');
  assert.equal(done.status, 'success');
  assert.equal(sent, true);
  // Deciding twice is harmless.
  assert.equal((await engine.decide(r.approvalId, 'approve')).already, true);
});

test('reject stops the run without running later steps', async () => {
  const engine = new Engine({ store: tmpStore() });
  let sent = false;
  engine.register({
    id: 'send',
    steps: [{ type: 'approval', title: 'Send?' }, { type: 'code', fn: () => { sent = true; } }],
  });
  const r = await engine.trigger('send');
  const done = await engine.decide(r.approvalId, 'reject');
  assert.equal(done.status, 'rejected');
  assert.equal(sent, false);
});

test('if step skips the rest when false', async () => {
  const engine = new Engine({ store: tmpStore() });
  let ran = false;
  engine.register({
    id: 'cond',
    steps: [{ type: 'if', name: 'big?', when: () => false }, { type: 'code', fn: () => { ran = true; } }],
  });
  assert.equal((await engine.trigger('cond')).status, 'success');
  assert.equal(ran, false);
});

test('paused flows do not run', async () => {
  const engine = new Engine({ store: tmpStore() });
  engine.register({ id: 'f', steps: [{ type: 'log', message: 'hi' }] });
  engine.setEnabled('f', false);
  assert.equal((await engine.trigger('f')).skipped, true);
  engine.setEnabled('f', true);
  assert.equal((await engine.trigger('f')).status, 'success');
});

test('rejects flows with unknown step types', () => {
  const engine = new Engine({ store: tmpStore() });
  assert.throws(() => engine.register({ id: 'x', steps: [{ type: 'teleport' }] }), /unknown step type/);
});

test('scheduler: everyMinutes and dailyAt in Brisbane time', () => {
  const t = new Date('2026-10-25T21:30:00Z'); // Mon 26 Oct 07:30 Brisbane
  assert.equal(isDue({ dailyAt: '07:30' }, t, null), true);
  assert.equal(isDue({ dailyAt: '07:30', days: [1, 5] }, t, null), true);
  assert.equal(isDue({ dailyAt: '07:30', days: [3] }, t, null), false);
  assert.equal(isDue({ dailyAt: '07:31' }, t, null), false);
  assert.equal(isDue({ everyMinutes: 5 }, t, null), true);
  assert.equal(isDue({ everyMinutes: 5 }, t, new Date(t.getTime() - 60_000).toISOString()), false);
  assert.equal(isDue({ everyMinutes: 5 }, t, new Date(t.getTime() - 300_000).toISOString()), true);
});

test('store survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-'));
  fs.writeFileSync(path.join(dir, 'runs.json'), '{not json');
  const store = new Store(dir);
  assert.deepEqual(store.load('runs'), []);
});
