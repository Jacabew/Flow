import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { startScheduler, missedSlot, slotToday } from '../src/scheduler.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-'));
// Brisbane = UTC+10. 2026-11-16 is a Monday.
const bne = (s) => new Date(`${s}+10:00`);
const settle = () => new Promise((r) => setTimeout(r, 30));

function setup(dir, schedule = { dailyAt: '08:30' }) {
  const store = new Store(dir);
  const engine = new Engine({ store });
  const calls = [];
  engine.register({ id: 'daily', schedule, steps: [{ type: 'code', fn: (ctx) => { calls.push(ctx.input); } }] });
  return { store, engine, calls };
}

async function startAt(engine, date) {
  const stop = startScheduler(engine, { tickMs: 1e9, now: () => date });
  await settle();
  stop();
}

test('slotToday gives the Brisbane slot as a UTC instant, null on an unscheduled day', () => {
  assert.equal(slotToday({ dailyAt: '08:30' }, bne('2026-11-16T15:00:00')).toISOString(), '2026-11-15T22:30:00.000Z');
  assert.equal(slotToday({ dailyAt: '00:10' }, bne('2026-11-16T00:05:00')).toISOString(), '2026-11-15T14:10:00.000Z');
  assert.equal(slotToday({ weekly: 'Tue 07:00' }, bne('2026-11-16T09:00:00')), null);
  assert.equal(slotToday({ everyMinutes: 5 }, bne('2026-11-16T09:00:00')), null);
});

test('missedSlot: only after the slot minute, only if the last run was before the slot, never without history', () => {
  const s = { dailyAt: '08:30' };
  const yesterday = bne('2026-11-15T08:30:05').toISOString();
  assert.equal(missedSlot(s, bne('2026-11-16T08:00:00'), yesterday), null); // not yet
  assert.equal(missedSlot(s, bne('2026-11-16T08:30:20'), yesterday), null); // isDue's minute
  assert.ok(missedSlot(s, bne('2026-11-16T08:31:00'), yesterday)); // missed
  assert.ok(missedSlot(s, bne('2026-11-16T23:59:00'), yesterday)); // still today
  assert.equal(missedSlot(s, bne('2026-11-16T09:00:00'), bne('2026-11-16T08:30:01').toISOString()), null); // ran
  assert.equal(missedSlot(s, bne('2026-11-16T09:00:00'), undefined), null); // never ran
});

test('restart after a missed slot runs the flow once, marked catchUp; a second restart does not repeat it', async () => {
  const dir = tmpDir();
  const a = setup(dir);
  await startAt(a.engine, bne('2026-11-15T08:30:10')); // ran yesterday on time
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].catchUp, undefined);

  const b = setup(dir); // HUB was off at 08:30 today, back at 09:12
  await startAt(b.engine, bne('2026-11-16T09:12:00'));
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].catchUp, true);
  assert.equal(b.calls[0].scheduledAt, bne('2026-11-16T08:30:00').toISOString());

  const c = setup(dir); // another restart later the same day
  await startAt(c.engine, bne('2026-11-16T10:00:00'));
  assert.equal(c.calls.length, 0);
});

test('first start with the feature falls back to the run log; no history means no catch-up', async () => {
  const dir = tmpDir();
  const a = setup(dir);
  a.store.insert('runs', { flowId: 'daily', source: 'schedule', status: 'success', startedAt: bne('2026-11-15T08:30:00').toISOString() });
  await startAt(a.engine, bne('2026-11-16T12:00:00'));
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].catchUp, true);

  const fresh = setup(tmpDir()); // brand-new flow deployed in the afternoon
  await startAt(fresh.engine, bne('2026-11-16T12:00:00'));
  assert.equal(fresh.calls.length, 0);
});

test('a missed slot from yesterday is not run today; paused flows are not caught up', async () => {
  const dir = tmpDir();
  const a = setup(dir);
  a.store.insert('schedule_state', { id: 'sched:daily', flowId: 'daily', lastRunAt: bne('2026-11-14T08:30:00').toISOString() });
  await startAt(a.engine, bne('2026-11-16T07:00:00')); // yesterday missed, today's slot not yet
  assert.equal(a.calls.length, 0);

  const b = setup(dir);
  b.engine.setEnabled('daily', false);
  await startAt(b.engine, bne('2026-11-16T09:00:00'));
  assert.equal(b.calls.length, 0);
});

test('weekly flow is caught up only on its own days', async () => {
  const dir = tmpDir();
  const a = setup(dir, { weekly: 'Mon,Fri 07:30' });
  a.store.insert('schedule_state', { id: 'sched:daily', flowId: 'daily', lastRunAt: bne('2026-11-13T07:30:00').toISOString() });
  await startAt(a.engine, bne('2026-11-17T09:00:00')); // Tuesday: Monday's miss is gone
  assert.equal(a.calls.length, 0);
  await startAt(a.engine, bne('2026-11-16T09:00:00')); // Monday
  assert.equal(a.calls.length, 1);
});

test('on-time run is recorded so a restart the same day does not re-run it', async () => {
  const dir = tmpDir();
  const a = setup(dir);
  await startAt(a.engine, bne('2026-11-16T08:30:00'));
  assert.equal(a.calls.length, 1);
  assert.equal(a.store.get('schedule_state', 'sched:daily').lastRunAt, bne('2026-11-16T08:30:00').toISOString());
  const b = setup(dir);
  await startAt(b.engine, bne('2026-11-16T08:45:00'));
  assert.equal(b.calls.length, 0);
});
