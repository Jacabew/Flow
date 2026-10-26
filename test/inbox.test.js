import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

async function start() {
  const flowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-flows-'));
  fs.writeFileSync(
    path.join(flowsDir, 'ask.js'),
    `export default { id: 'ask', steps: [
      { type: 'approval', name: 'ok', title: 'Send <b>quote</b>?', detail: 'to Ann' },
      { type: 'code', name: 'after', fn: () => 'done' },
    ] };`,
  );
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')), apiKey: 'k', flowsDir });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, close: () => new Promise((r) => app.server.close(r)) };
}
const H = { 'x-api-key': 'k' };

test('/inbox serves the phone page without a key and without any data in it', async () => {
  const app = await start();
  try {
    await app.engine.trigger('ask', {}, 'manual');
    const res = await fetch(`${app.base}/inbox`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await res.text();
    assert.match(html, /name="viewport"/);
    assert.match(html, /\/api\/approvals/);
    assert.doesNotMatch(html, /Send <b>quote/); // approvals only come via the authed API
    assert.equal((await fetch(`${app.base}/inbox`, { method: 'POST' })).status, 401);
  } finally { await app.close(); }
});

test('inbox flow over the API: list pending, approve resumes the run, unknown id is 404', async () => {
  const app = await start();
  try {
    const r = await app.engine.trigger('ask', {}, 'manual');
    assert.equal((await fetch(`${app.base}/api/approvals`)).status, 401);
    const list = await (await fetch(`${app.base}/api/approvals`, { headers: H })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Send <b>quote</b>?');
    assert.equal(list[0].detail, 'to Ann');

    const bad = await fetch(`${app.base}/api/approvals/nope/approve`, { method: 'POST', headers: H });
    assert.equal(bad.status, 404);

    const ok = await fetch(`${app.base}/api/approvals/${list[0].id}/approve`, { method: 'POST', headers: H });
    assert.equal(ok.status, 200);
    assert.equal(app.store.get('runs', r.runId).status, 'success');
    assert.equal(app.store.get('runs', r.runId).steps.after, 'done');
    assert.deepEqual(await (await fetch(`${app.base}/api/approvals`, { headers: H })).json(), []);
  } finally { await app.close(); }
});

test('reject over the API stops the run', async () => {
  const app = await start();
  try {
    const r = await app.engine.trigger('ask', {}, 'manual');
    const res = await fetch(`${app.base}/api/approvals/${r.approvalId}/reject`, { method: 'POST', headers: H });
    assert.equal(res.status, 200);
    assert.notEqual(app.store.get('runs', r.runId).status, 'success');
    assert.equal(app.store.get('runs', r.runId).steps.after, undefined);
  } finally { await app.close(); }
});
