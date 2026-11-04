import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createFlowClient, FlowApiError } from '../client/index.js';

async function start() {
  const flowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-flows-'));
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-agents-'));
  fs.writeFileSync(path.join(flowsDir, 'echo.js'),
    `export default { id: 'echo', webhookSecret: 'hush', steps: [{ type: 'code', name: 'out', fn: (c) => c.input }] };`);
  fs.writeFileSync(path.join(flowsDir, 'ask.js'),
    `export default { id: 'ask', steps: [{ type: 'approval', name: 'ok', title: 'Go?' }, { type: 'log', name: 'done', message: 'went' }] };`);
  fs.writeFileSync(path.join(agentsDir, 'helper.js'),
    `export default { id: 'helper', name: 'Helper', job: 'Tests.', actions: {} };`);
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsflow-')), apiKey: 'k', flowsDir, agentsDir, env: {} });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}/`; // trailing slash on purpose
  return { ...app, base, close: () => new Promise((r) => app.server.close(r)) };
}

test('client: status, flows, runs and webhook against a real server', async () => {
  const app = await start();
  try {
    const flow = createFlowClient({ baseUrl: app.base, apiKey: 'k' });
    assert.equal((await flow.health()).ok, true);
    assert.equal((await flow.summary()).schema, 1);
    assert.deepEqual((await flow.flows()).map((f) => f.id).sort(), ['ask', 'echo']);

    const run = await flow.runFlow('echo', { name: 'Ann' });
    assert.equal(run.status, 'success');
    assert.deepEqual(app.store.get('runs', run.runId).steps.out, { name: 'Ann' });

    const hooked = await flow.triggerWebhook('echo', 'hush', { via: 'hook' });
    assert.equal(hooked.status, 'success');
    assert.equal((await flow.runs({ status: 'success' })).length, 2);

    await flow.pauseFlow('echo');
    assert.equal((await flow.runFlow('echo')).skipped, true);
    await flow.resumeFlow('echo');
    assert.equal((await flow.runFlow('echo')).status, 'success');

    assert.ok(Array.isArray(await flow.alerts()));
    assert.ok(Array.isArray(await flow.shadow({ flow: 'echo' })));
    assert.ok('dsos' in (await flow.connectors()));
    assert.ok('drafted' in (await flow.shadowReport('enquiries')));
  } finally { await app.close(); }
});

test('client: approvals and agent pause switch', async () => {
  const app = await start();
  try {
    const flow = createFlowClient({ baseUrl: app.base, apiKey: 'k' });
    await flow.runFlow('ask');
    const [pending] = await flow.approvals();
    assert.equal(pending.title, 'Go?');
    await flow.approve(pending.id);
    assert.equal((await flow.approvals()).length, 0);
    assert.equal((await flow.runs({ status: 'success' })).length, 1);

    assert.deepEqual((await flow.pauseAgent('helper')).paused, true);
    assert.equal((await flow.agents())[0].paused, true);
    await flow.resumeAgent('helper');
    assert.equal((await flow.pauseAllAgents()).allAgentsPaused, true);
    assert.equal((await flow.resumeAllAgents()).allAgentsPaused, false);
  } finally { await app.close(); }
});

test('client: errors come back as FlowApiError with status', async () => {
  const app = await start();
  try {
    const bad = createFlowClient({ baseUrl: app.base, apiKey: 'wrong' });
    await assert.rejects(bad.summary(), (e) => e instanceof FlowApiError && e.status === 401);
    const flow = createFlowClient({ baseUrl: app.base, apiKey: 'k' });
    await assert.rejects(flow.runFlow('nope'), (e) => e.status === 404 && e.body.error === 'flow not found');
    await assert.rejects(flow.approve('nope'), (e) => e.status === 404);
    await assert.rejects(flow.pauseAgent('nope'), (e) => e.status === 404);
    await assert.rejects(flow.triggerWebhook('echo', 'wrong'), (e) => e.status === 404);
    // Health needs no key, so a keyless client can still check the HUB is up.
    assert.equal((await createFlowClient({ baseUrl: app.base }).health()).ok, true);
  } finally { await app.close(); }
});

test('client: input checks and id encoding', async () => {
  assert.throws(() => createFlowClient({}), /baseUrl is required/);
  const noKey = createFlowClient({ baseUrl: 'http://x' , fetch: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(noKey.summary(), /apiKey is required/);

  const seen = [];
  const fake = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); };
  const flow = createFlowClient({ baseUrl: 'http://hub:5680', apiKey: 'k', fetch: fake });
  await assert.rejects(flow.runFlow(''), /non-empty/);
  await flow.runFlow('a/../b', { x: 1 });
  assert.equal(seen[0].url, 'http://hub:5680/api/flows/a%2F..%2Fb/run');
  assert.equal(seen[0].init.headers['x-api-key'], 'k');
  assert.equal(seen[0].init.body, '{"x":1}');
  await flow.runs();
  assert.equal(seen[1].url, 'http://hub:5680/api/runs'); // no empty ?status=
  await flow.triggerWebhook('enquiry', 'a b&c');
  assert.equal(seen[2].url, 'http://hub:5680/hooks/enquiry?secret=a+b%26c');
  assert.equal(seen[2].init.headers['x-api-key'], undefined); // API key never sent to /hooks
});
