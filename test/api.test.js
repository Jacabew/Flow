import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

async function start() {
  const flowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-flows-'));
  fs.writeFileSync(
    path.join(flowsDir, 'hook.js'),
    `export default { id: 'hook', webhookSecret: 's3cret', steps: [{ type: 'code', name: 'echo', fn: (c) => c.input }] };`,
  );
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')), apiKey: 'k', flowsDir });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, close: () => new Promise((r) => app.server.close(r)) };
}

test('health is open, api needs a key', async () => {
  const app = await start();
  try {
    assert.equal((await fetch(`${app.base}/health`)).status, 200);
    assert.equal((await fetch(`${app.base}/api/summary`)).status, 401);
    const ok = await fetch(`${app.base}/api/summary`, { headers: { 'x-api-key': 'k' } });
    assert.equal(ok.status, 200);
  } finally { await app.close(); }
});

test('webhook triggers a flow only with the right secret', async () => {
  const app = await start();
  try {
    const bad = await fetch(`${app.base}/hooks/hook?secret=wrong`, { method: 'POST', body: '{}' });
    assert.equal(bad.status, 404);
    const res = await fetch(`${app.base}/hooks/hook?secret=s3cret`, { method: 'POST', body: JSON.stringify({ name: 'Ann' }) });
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.deepEqual(app.store.get('runs', body.runId).steps.echo, { name: 'Ann' });
  } finally { await app.close(); }
});
