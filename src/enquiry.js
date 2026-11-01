// Enquiry responder, SHADOW RUN (drafts, never sends).
//
// Website enquiry form → webhook → DS Flow:
//   1. normalises the form post (JSON or form-encoded, common field names),
//   2. screens it: needs an email, drops honeypot/link-spam, drops double-submits,
//   3. drafts a plain reply from a fixed template picked by keywords (deterministic: no AI),
//      offering the introduction chat (a phone call Jake makes, D31) via the booking page,
//   4. records the draft for review at GET /api/shadow/enquiries.
// DS Flow has no email connector at all, so nothing can be sent from here. The DSOS lead it
// would create is logged in the shadow log via a dsos write with no `live` flag.
import fs from 'node:fs';
import path from 'node:path';

export const ENQUIRY_COLLECTION = 'enquiry_shadow';
export const KEEP = 500;
export const DUPLICATE_WINDOW_MS = 30 * 60_000;
const MAX_LINKS = 2;

const clean = (v, max = 200) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanBlock = (v, max = 4000) => (v === undefined || v === null ? '' : String(v)).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);

// Field lookup ignoring case, spaces, dashes and underscores ("First Name" = first_name).
function finder(obj) {
  const map = new Map();
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') map.set(k.toLowerCase().replace(/[\s_\-]/g, ''), v);
  }
  return (...keys) => {
    for (const k of keys) if (map.has(k)) return map.get(k);
    return undefined;
  };
}

// Unwrap the shapes form tools send: { data: {...} }, { submission: {...} }, { fields: [{label,value}] },
// a form-encoded body (arrives as { raw: 'a=1&b=2' }), or a flat object.
export function flattenForm(input) {
  let body = input ?? {};
  if (typeof body.raw === 'string') {
    const out = {};
    for (const [k, v] of new URLSearchParams(body.raw)) out[k] = v;
    body = out;
  }
  for (const k of ['data', 'submission', 'formData', 'form_data', 'values']) {
    if (body[k] && typeof body[k] === 'object' && !Array.isArray(body[k])) body = { ...body, ...body[k] };
  }
  if (Array.isArray(body.fields)) {
    body = { ...body };
    for (const f of body.fields) {
      const key = f?.label ?? f?.name ?? f?.key;
      if (key) body[key] = f.value;
    }
  }
  return body;
}

export function normaliseEnquiry(input) {
  const body = flattenForm(input);
  const get = finder(body);
  const first = clean(get('firstname', 'first', 'givenname'), 80);
  const last = clean(get('lastname', 'last', 'surname', 'familyname'), 80);
  const name = clean(get('name', 'fullname', 'yourname', 'contactname') ?? [first, last].filter(Boolean).join(' '), 120);
  const email = clean(get('email', 'emailaddress', 'youremail', 'replyto'), 200).toLowerCase();
  return {
    name,
    firstName: first || name.split(' ')[0] || '',
    email,
    phone: clean(get('phone', 'phonenumber', 'mobile', 'mobilenumber', 'tel', 'contactnumber'), 40),
    siteAddress: clean(get('siteaddress', 'projectaddress', 'address', 'location', 'suburb'), 200),
    message: cleanBlock(get('message', 'enquiry', 'inquiry', 'comments', 'details', 'projectdetails', 'description', 'body')),
    service: clean(get('service', 'interest', 'servicetype', 'enquirytype', 'inquirytype', 'subject'), 120),
    heardFrom: clean(get('source', 'heardfrom', 'howdidyouhear', 'howdidyoufindus', 'referral', 'referrer'), 120),
    honeypot: clean(get('honeypot', 'website2', 'botfield', 'hp', 'gotcha', 'gotcha_'), 200),
  };
}

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

// Screen before drafting. Returns { ok, reason? }.
export function screenEnquiry(e) {
  if (e.honeypot) return { ok: false, reason: 'spam: hidden field filled' };
  if (!EMAIL_RE.test(e.email)) return { ok: false, reason: e.email ? 'email address not valid' : 'no email address' };
  if (!e.message && !e.service) return { ok: false, reason: 'empty enquiry' };
  const links = (`${e.message} ${e.name}`.match(/https?:\/\/|www\./gi) ?? []).length;
  if (links > MAX_LINKS) return { ok: false, reason: `spam: ${links} links` };
  if (/https?:\/\/|www\./i.test(e.name)) return { ok: false, reason: 'spam: link in name' };
  return { ok: true };
}

// Topic by keywords, first match wins. Order: the most specific DarkSpace work first.
export const TOPICS = [
  { id: 'lighting-design', words: ['lighting design', 'lighting plan', 'lighting layout', 'designer', 'design', 'renovat', 'new build', 'architect', 'builder', 'downlight', 'pendant', 'feature light', 'landscape', 'garden light'],
    line: 'Lighting design is what we do best, and the earlier we get involved the more we can do for the space.' },
  { id: 'controls', words: ['control', 'automation', 'smart', 'dali', 'dimming', 'dimmer', 'scene', 'c-bus', 'cbus', 'dynalite', 'casambi'],
    line: 'Lighting control is a big part of our work: scenes, dimming and automation that just works without anyone thinking about it.' },
  { id: 'supply', words: ['supply', 'fitting', 'luminaire', 'fixture', 'price', 'pricing', 'quote for', 'product'],
    line: 'We supply the fittings we specify, so the lights that turn up are the lights that were designed.' },
  { id: 'electrical', words: ['electric', 'wiring', 'rewire', 'power point', 'powerpoint', 'switchboard', 'install', 'fault', 'repair', 'sparky'],
    line: 'Our electrical work is done with lighting in mind, so the install matches the design.' },
];

export function pickTopic(e) {
  const text = `${e.service} ${e.message}`.toLowerCase();
  return TOPICS.find((t) => t.words.some((w) => text.includes(w)))?.id ?? 'general';
}

// Plain-text draft. Deterministic: same enquiry + options → same words.
export function draftReply(e, { bookingUrl = null } = {}) {
  const topic = pickTopic(e);
  const hello = e.firstName ? `Hi ${e.firstName},` : 'Hi there,';
  const lines = [
    hello,
    '',
    'Thanks for getting in touch with DarkSpace.' + (e.siteAddress ? ` I've noted the site at ${e.siteAddress}.` : ''),
  ];
  const t = TOPICS.find((x) => x.id === topic);
  if (t) lines.push('', t.line);
  lines.push('', 'The best first step is a short introduction chat. It\'s a phone call: I ring you, hear about the project, and we work out together whether a consultation makes sense.');
  if (bookingUrl) lines.push('', `You can pick a time that suits here: ${bookingUrl}`);
  else lines.push('', 'Just reply with a couple of times that suit and the best number to call.');
  if (e.phone && bookingUrl) lines.push('', `If it's easier, reply and I'll call you on ${e.phone}.`);
  lines.push('', 'Kind regards,', 'Jake Wood', 'DarkSpace | Intelligent Lighting for Effortless Living');
  const subject = topic === 'general' ? 'Thanks for your enquiry | DarkSpace' : `Your ${TOPIC_LABEL[topic]} enquiry | DarkSpace`;
  return { topic, subject, text: lines.join('\n'), bookingLink: Boolean(bookingUrl) };
}

const TOPIC_LABEL = { 'lighting-design': 'lighting design', controls: 'lighting control', supply: 'lighting supply', electrical: 'electrical' };

// The lead DS Flow would ask DSOS to create (D32: a lead, not a client; DSOS matches on email).
export function leadPayload(e) {
  return {
    source: 'website enquiry',
    name: e.name || null,
    email: e.email,
    phone: e.phone || null,
    siteAddress: e.siteAddress || null,
    notes: [e.service && `Interest: ${e.service}`, e.heardFrom && `Heard from: ${e.heardFrom}`, e.message].filter(Boolean).join('\n') || null,
    status: 'new',
    createdBy: 'ds-flow',
  };
}

// Double-submit check: same email and message within the window.
export function findDuplicate(store, e, now) {
  const since = now.getTime() - DUPLICATE_WINDOW_MS;
  return store.list(ENQUIRY_COLLECTION, (r) =>
    r.verdict === 'drafted' && r.enquiry?.email === e.email && r.enquiry?.message === e.message && Date.parse(r.at) >= since,
  ).at(-1) ?? null;
}

export function recordEnquiry(store, row) {
  const out = store.insert(ENQUIRY_COLLECTION, row);
  store.trim(ENQUIRY_COLLECTION, KEEP);
  return out;
}

// Settings read at run time (no restart needed). Booking page and from-address aren't secrets.
export function enquiryConfig(env = process.env) {
  return {
    bookingUrl: env.FLOW_BOOKING_URL?.trim() || null,
    from: env.FLOW_ENQUIRY_FROM?.trim() || null,
  };
}

// Webhook secret: FLOW_ENQUIRY_SECRET or FLOW_SECRETS_DIR\enquiry-webhook-secret.txt. None = webhook off.
export function enquirySecret(env = process.env) {
  const fromEnv = env.FLOW_ENQUIRY_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (!env.FLOW_SECRETS_DIR) return null;
  try {
    return fs.readFileSync(path.join(env.FLOW_SECRETS_DIR, 'enquiry-webhook-secret.txt'), 'utf8').trim() || null;
  } catch { return null; }
}

export function enquiryReport(store, limit = 50) {
  const rows = store.list(ENQUIRY_COLLECTION);
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const drafted = count('drafted');
  return {
    total: rows.length,
    drafted,
    screenedOut: count('screened-out'),
    duplicates: count('duplicate'),
    headline: `Enquiry responder shadow: ${drafted} draft${drafted === 1 ? '' : 's'} ready to review, nothing sent`,
    recent: rows.slice(-limit).reverse(),
  };
}
