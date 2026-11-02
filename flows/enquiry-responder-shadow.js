// SHADOW RUN for the enquiry responder. Triggered by the website enquiry form:
//   POST /hooks/enquiry-responder-shadow?secret=<FLOW_SECRETS_DIR\enquiry-webhook-secret.txt>
// (or POST /api/flows/enquiry-responder-shadow/run with the API key, for testing).
//   1. normalise + screen the enquiry (no email, spam, double-submit → recorded, no draft),
//   2. draft the reply from a fixed template (no AI),
//   3. log the DSOS lead it WOULD create (shadow write, no `live` flag: can't go real),
//   4. record the email it WOULD send. There is no email connector, so nothing is sent.
// Review drafts: GET /api/shadow/enquiries
import {
  normaliseEnquiry, screenEnquiry, draftReply, leadPayload, findDuplicate, recordEnquiry,
  enquiryConfig, enquirySecret,
} from '../src/enquiry.js';

export const LEADS_PATH = '/api/v1/leads';

export default {
  id: 'enquiry-responder-shadow',
  agent: 'enquiry-responder',
  description: 'Shadow: drafts a reply to each website enquiry and logs the DSOS lead it would create. Sends nothing.',
  webhookSecret: () => enquirySecret(),
  steps: [
    {
      type: 'code',
      name: 'screen',
      fn: (ctx) => {
        const now = ctx.now();
        const enquiry = normaliseEnquiry(ctx.input);
        const { honeypot, ...kept } = enquiry;
        const screen = screenEnquiry(enquiry);
        let verdict = screen.ok ? 'drafted' : 'screened-out';
        let reason = screen.reason ?? null;
        const dup = screen.ok ? findDuplicate(ctx.store, enquiry, now) : null;
        if (dup) { verdict = 'duplicate'; reason = `same as ${dup.id}`; }
        if (verdict !== 'drafted') {
          recordEnquiry(ctx.store, { at: now.toISOString(), runId: ctx.runId, verdict, reason, enquiry: kept });
        }
        return { verdict, reason, enquiry: kept };
      },
    },
    { type: 'if', name: 'worth-drafting', when: (ctx) => ctx.steps.screen.verdict === 'drafted' },
    {
      type: 'code',
      name: 'draft',
      fn: (ctx) => draftReply(ctx.steps.screen.enquiry, enquiryConfig()),
    },
    {
      type: 'dsos',
      name: 'would-create-lead',
      method: 'POST',
      path: LEADS_PATH,
      body: (ctx) => leadPayload(ctx.steps.screen.enquiry),
    },
    {
      type: 'code',
      name: 'would-send',
      fn: (ctx) => {
        if (!ctx.steps['would-create-lead']?.shadow) throw new Error('lead write was not shadowed; refusing to continue');
        const at = ctx.now().toISOString();
        const { enquiry } = ctx.steps.screen;
        const d = ctx.steps.draft;
        const email = { to: enquiry.email, from: enquiryConfig().from, subject: d.subject, text: d.text };
        ctx.store.insert('shadow', { connector: 'email', flowId: ctx.flowId, runId: ctx.runId, at, method: 'SEND', path: null, query: null, body: email });
        ctx.store.trim('shadow', 5000);
        const row = recordEnquiry(ctx.store, {
          at, runId: ctx.runId, verdict: 'drafted', reason: null, topic: d.topic, bookingLink: d.bookingLink, enquiry, email,
        });
        return { shadowed: true, id: row.id, topic: d.topic };
      },
    },
  ],
};
