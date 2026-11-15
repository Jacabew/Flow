import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAlerter } from '../src/alerts.js';

const fakeStore = () => ({ rows: [], insert(t, r) { this.rows.push(r); }, trim() {} });

test('alert reads ntfy topic from secrets file at call time', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-alerts-'));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); return { ok: true }; });
  const store = fakeStore();
  const alert = makeAlerter(store, { FLOW_SECRETS_DIR: dir });

  await alert({ flowId: 'f', runId: 'r', message: 'boom' });
  assert.equal(calls.length, 0, 'no topic yet: record only');
  assert.equal(store.rows.length, 1);

  fs.writeFileSync(path.join(dir, 'ntfy-topic.txt'), 'my-topic\r\n');
  await alert({ flowId: 'f', runId: 'r', message: 'boom' });
  assert.deepEqual(calls, ['https://ntfy.sh/my-topic']);
});

test('env topic wins over the file', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); return { ok: true }; });
  await makeAlerter(fakeStore(), { FLOW_ALERT_NTFY_TOPIC: 'env-topic', FLOW_SECRETS_DIR: '/nope' })({ flowId: 'f', runId: 'r', message: 'x' });
  assert.deepEqual(calls, ['https://ntfy.sh/env-topic']);
});
