import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { makeDsosClient } from '../src/connectors/dsos.js';
import {
  normaliseEnquiry, screenEnquiry, pickTopic, draftReply, leadPayload, enquiryReport, enquirySecret,
  ENQUIRY_COLLECTION,
} from '../src/enquiry.js';
import flow from '../flows/enquiry-responder-shadow.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sample = (over = {}) => ({
  name: 'Sam Taylor', email: 'Sam@Example.com', phone: '0400 000 000', address: '12 Beach Rd, Moffat Beach',
  message: 'We are renovating and want a lighting design for the kitchen and living areas.', ...over,
});

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

test('normaliseEnquiry reads flat, nested, field-list and form-encoded posts', () => {
  const a = normaliseEnquiry(sample());
  assert.equal(a.email, 'sam@example.com');
  assert.equal(a.firstName, 'Sam');
  assert.equal(a.siteAddress, '12 Beach Rd, Moffat Beach');

  const b = normaliseEnquiry({ data: { 'First Name': 'Lee', 'Last Name': 'Ng', 'Email Address': 'lee@x.com.au', 'Project Details': 'Downlights' } });
  assert.equal(b.name, 'Lee Ng');
  assert.equal(b.email, 'lee@x.com.au');
  assert.equal(b.message, 'Downlights');

  const c = normaliseEnquiry({ fields: [{ label: 'Name', value: 'Kim' }, { label: 'Email', value: 'kim@x.com' }, { label: 'Message', value: 'Hi' }] });
  assert.deepEqual([c.name, c.email, c.message], ['Kim', 'kim@x.com', 'Hi']);

  const d = normaliseEnquiry({ raw: 'name=Jo+Bloggs&email=jo%40x.com&enquiry=Need+a+rewire' });
  assert.deepEqual([d.name, d.email, d.message], ['Jo Bloggs', 'jo@x.com', 'Need a rewire']);

  const e = normaliseEnquiry(null);
  assert.equal(e.email, '');
});

test('screenEnquiry drops missing email, honeypot, link spam and empty enquiries', () => {
  assert.deepEqual(screenEnquiry(normaliseEnquiry(sample())), { ok: true });
  assert.equal(screenEnquiry(normaliseEnquiry(sample({ email: '' }))).reason, 'no email address');
  assert.equal(screenEnquiry(normaliseEnquiry(sample({ email: 'nope' }))).reason, 'email address not valid');
  assert.match(screenEnquiry(normaliseEnquiry(sample({ website2: 'bot' }))).reason, /hidden field/);
  assert.match(screenEnquiry(normaliseEnquiry(sample({ message: 'http://a.io http://b.io www.c.io' }))).reason, /3 links/);
  assert.match(screenEnquiry(normaliseEnquiry(sample({ name: 'www.cheap.biz' }))).reason, /link in name/);
  assert.equal(screenEnquiry(normaliseEnquiry(sample({ message: '' }))).reason, 'empty enquiry');
});

test('pickTopic and draftReply are deterministic, with or without a booking link', () => {
  const e = normaliseEnquiry(sample());
  assert.equal(pickTopic(e), 'lighting-design');
  assert.equal(pickTopic(normaliseEnquiry(sample({ message: 'Can you set up DALI dimming scenes?' }))), 'controls');
  assert.equal(pickTopic(normaliseEnquiry(sample({ message: 'Need a switchboard upgrade' }))), 'electrical');
  assert.equal(pickTopic(normaliseEnquiry(sample({ message: 'Hello, are you happy to chat?' }))), 'general');

  const a = draftReply(e, { bookingUrl: 'https://book.example/intro' });
  assert.deepEqual(a, draftReply(e, { bookingUrl: 'https://book.example/intro' }));
  assert.equal(a.subject, 'Your lighting design enquiry | DarkSpace');
  assert.match(a.text, /^Hi Sam,/);
  assert.match(a.text, /12 Beach Rd/);
  assert.match(a.text, /https:\/\/book\.example\/intro/);
  assert.match(a.text, /call you on 0400 000 000/);
  assert.equal(a.bookingLink, true);

  const b = draftReply(normaliseEnquiry(sample({ name: '', phone: '', message: 'hi' })));
  assert.match(b.text, /^Hi there,/);
  assert.match(b.text, /reply with a couple of times/);
  assert.equal(b.bookingLink, false);
  assert.equal(b.subject, 'Thanks for your enquiry | DarkSpace');
});

test('leadPayload is a DSOS lead from a website enquiry', () => {
  const l = leadPayload(normaliseEnquiry(sample({ service: 'Lighting design', heardFrom: 'Instagram' })));
  assert.equal(l.source, 'website enquiry');
  assert.equal(l.status, 'new');
  assert.equal(l.email, 'sam@example.com');
  assert.match(l.notes, /Interest: Lighting design\nHeard from: Instagram\nWe are renovating/);
});

test('flow drafts, shadows the lead and the email, and sends nothing (even with DSOS writes live)', async () => {
  const store = new Store(tmp('dsflow-enq-'));
  const sent = [];
  const fetchImpl = async (...args) => { sent.push(args); throw new Error('must not be called'); };
  const dsos = makeDsosClient({ env: { FLOW_DSOS_TOKEN: 't', FLOW_DSOS_WRITES: 'live' }, fetchImpl });
  let clock = new Date('2026-11-02T09:00:00+10:00');
  const engine = new Engine({ store, now: () => clock, connectors: { dsos } });
  engine.register(flow);

  await withEnv({ FLOW_BOOKING_URL: 'https://book.example/intro', FLOW_ENQUIRY_FROM: 'jake@example.com' }, async () => {
    const run = await engine.trigger(flow.id, sample(), 'webhook');
    assert.equal(run.status, 'success');
    assert.equal(sent.length, 0, 'no network call');
    const shadow = store.list('shadow');
    assert.deepEqual(shadow.map((s) => s.connector), ['dsos', 'email']);
    assert.equal(shadow[0].path, '/api/v1/leads');
    assert.equal(shadow[1].body.to, 'sam@example.com');
    assert.equal(shadow[1].body.from, 'jake@example.com');
    const [row] = store.list(ENQUIRY_COLLECTION);
    assert.equal(row.verdict, 'drafted');
    assert.equal(row.topic, 'lighting-design');
    assert.equal(row.bookingLink, true);
    assert.equal('honeypot' in row.enquiry, false);

    // Double-submit within 30 min: recorded, no second draft.
    clock = new Date(clock.getTime() + 5 * 60_000);
    await engine.trigger(flow.id, sample(), 'webhook');
    // Spam: recorded as screened out.
    await engine.trigger(flow.id, sample({ email: '' }), 'webhook');
    // Same enquiry an hour later is a new draft.
    clock = new Date(clock.getTime() + 60 * 60_000);
    await engine.trigger(flow.id, sample(), 'webhook');

    const r = enquiryReport(store);
    assert.deepEqual([r.total, r.drafted, r.duplicates, r.screenedOut], [4, 2, 1, 1]);
    assert.equal(r.recent[0].verdict, 'drafted');
    assert.match(r.headline, /2 drafts ready to review, nothing sent/);
    assert.equal(store.list('shadow', (s) => s.connector === 'email').length, 2);
  });
});

test('enquirySecret: env first, then the secrets folder, else webhook off', () => {
  const dir = tmp('dsflow-sec-');
  assert.equal(enquirySecret({}), null);
  assert.equal(enquirySecret({ FLOW_SECRETS_DIR: dir }), null);
  fs.writeFileSync(path.join(dir, 'enquiry-webhook-secret.txt'), 'abc123\n');
  assert.equal(enquirySecret({ FLOW_SECRETS_DIR: dir }), 'abc123');
  assert.equal(enquirySecret({ FLOW_SECRETS_DIR: dir, FLOW_ENQUIRY_SECRET: 'env1' }), 'env1');
});

test('webhook + report over HTTP: 404 with no secret set, drafts with the right one', async () => {
  const flowsDir = tmp('dsflow-enq-flows-');
  const flowUrl = pathToFileURL(path.resolve('flows/enquiry-responder-shadow.js')).href;
  fs.writeFileSync(path.join(flowsDir, 'enq.js'), `export { default } from ${JSON.stringify(flowUrl)};`);
  const secretsDir = tmp('dsflow-enq-secrets-');
  await withEnv({ FLOW_SECRETS_DIR: secretsDir, FLOW_ENQUIRY_SECRET: undefined, FLOW_BOOKING_URL: undefined }, async () => {
    const app = createApp({ dataDir: tmp('dsflow-enq-api-'), apiKey: 'k', flowsDir, env: {} });
    await app.ready;
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      const post = (secret, body) => fetch(`${base}/hooks/enquiry-responder-shadow?secret=${secret}`, { method: 'POST', body });
      assert.equal((await post('', JSON.stringify(sample()))).status, 404, 'no secret file = webhook off');
      fs.writeFileSync(path.join(secretsDir, 'enquiry-webhook-secret.txt'), 'hook-secret');
      assert.equal((await post('wrong', JSON.stringify(sample()))).status, 404);
      const ok = await post('hook-secret', 'name=Jo&email=jo%40x.com&message=Need+downlights');
      assert.equal(ok.status, 202);
      assert.equal((await ok.json()).status, 'success');

      assert.equal((await fetch(`${base}/api/shadow/enquiries`)).status, 401);
      const rep = await (await fetch(`${base}/api/shadow/enquiries`, { headers: { 'x-api-key': 'k' } })).json();
      assert.equal(rep.drafted, 1);
      assert.equal(rep.recent[0].email.to, 'jo@x.com');
      assert.match(rep.recent[0].email.text, /reply with a couple of times/);
    } finally { await new Promise((r) => app.server.close(r)); }
  });
});
