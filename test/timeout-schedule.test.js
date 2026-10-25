import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine, stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS } from '../src/engine.js';
import { isDue, normalizeSchedule } from '../src/scheduler.js';

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')));

test('a hung code step times out, fails the run and alerts', async () => {
  const alerts = [];
  const engine = new Engine({ store: tmpStore(), alert: async (a) => alerts.push(a) });
  engine.register({ id: 'hang', steps: [{ type: 'code', name: 'h', timeoutMs: 20, fn: () => new Promise(() => {}) }] });
  const r = await engine.trigger('hang');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /h: timed out after 20 ms/);
  assert.equal(alerts.length, 1);
});

test('a timed-out step is retried, and ctx.signal aborts the abandoned attempt', async () => {
  const engine = new Engine({ store: tmpStore() });
  let calls = 0;
  let abortedFirst = false;
  engine.register({
    id: 'slow-then-fast',
    steps: [{
      type: 'code', name: 's', timeoutMs: 20, retries: 1, retryDelayMs: 1,
      fn: (ctx) => {
        calls++;
        if (calls === 1) {
          ctx.signal.addEventListener('abort', () => { abortedFirst = true; });
          return new Promise(() => {});
        }
        return 'done';
      },
    }],
  });
  const r = await engine.trigger('slow-then-fast');
  assert.equal(r.status, 'success');
  assert.equal(calls, 2);
  assert.equal(abortedFirst, true);
});

test('wait step longer than its timeout fails; within it succeeds', async () => {
  const engine = new Engine({ store: tmpStore() });
  engine.register({ id: 'w1', steps: [{ type: 'wait', ms: 200, timeoutMs: 20 }] });
  engine.register({ id: 'w2', steps: [{ type: 'wait', ms: 5, timeoutMs: 200 }] });
  assert.equal((await engine.trigger('w1')).status, 'failed');
  assert.equal((await engine.trigger('w2')).status, 'success');
});

test('if step still stops the run (ctx shared with timeout wrapper)', async () => {
  const engine = new Engine({ store: tmpStore() });
  let ran = false;
  engine.register({ id: 'br', steps: [{ type: 'if', when: () => false }, { type: 'code', fn: () => { ran = true; } }] });
  assert.equal((await engine.trigger('br')).status, 'success');
  assert.equal(ran, false);
});

test('default timeouts per step type', () => {
  assert.equal(stepTimeoutMs({ type: 'code' }), DEFAULT_STEP_TIMEOUT_MS);
  assert.equal(stepTimeoutMs({ type: 'code', timeoutMs: 50 }), 50);
  assert.equal(stepTimeoutMs({ type: 'http' }), 31_000);
  assert.equal(stepTimeoutMs({ type: 'http', timeoutMs: 5000 }), 6000);
  assert.equal(stepTimeoutMs({ type: 'wait', ms: 10 * 60_000 }), 10 * 60_000 + 5000);
});

test('weekly schedule: "Mon,Wed 07:30" and day names', () => {
  const mon = new Date('2026-10-25T21:30:00Z'); // Mon 26 Oct 07:30 Brisbane
  const tue = new Date('2026-10-26T21:30:00Z'); // Tue 27 Oct 07:30
  const wed = new Date('2026-10-27T21:30:00Z'); // Wed 28 Oct 07:30
  const s = { weekly: 'Mon,Wed 07:30' };
  assert.equal(isDue(s, mon, null), true);
  assert.equal(isDue(s, tue, null), false);
  assert.equal(isDue(s, wed, null), true);
  assert.equal(isDue({ dailyAt: '07:30', days: ['Monday', 'fri'] }, mon, null), true);
  assert.deepEqual(normalizeSchedule({ weekly: 'mon, wed 7:30' }), { dailyAt: '07:30', days: [1, 3] });
});

test('bad schedules fail at register time, not silently', () => {
  const engine = new Engine({ store: tmpStore() });
  const reg = (schedule) => engine.register({ id: 'x', schedule, steps: [] });
  assert.throws(() => reg({ weekly: 'Mon,Wed' }), /should look like/);
  assert.throws(() => reg({ weekly: 'Mon,Funday 07:30' }), /unknown day "Funday"/);
  assert.throws(() => reg({ dailyAt: '25:00' }), /HH:MM/);
  assert.throws(() => reg({ dailyAt: '07:30', days: [] }), /non-empty/);
  assert.throws(() => reg({ everyMinutes: 0 }), /> 0/);
  assert.throws(() => reg({}), /HH:MM/);
});
