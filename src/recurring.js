// Recurring invoices (workshop rent etc.), shadow run.
//
// DSOS already owns recurring schedules: their lines, Xero push, period wording and timing
// rules (D45-D47). Same split as the Xero back-feed: DS Flow aims to own the *trigger* and the
// alerting, never the invoice logic or Xero credentials. Before any switch-over it shadows:
//   - each evening it reads DSOS's schedules and records which ones DSOS says are due TOMORROW
//     (by DSOS's own next-run date) and the amount it expects;
//   - it logs the "generate due invoices" call it WOULD send that morning (shadow, never sent);
//   - it checks YESTERDAY: did DSOS generate exactly the predicted invoices, at the predicted
//     amounts, and nothing unexpected?
// Ready to switch = 31 checked days in a row with no mismatch and at least one invoice matched.
import { brisbaneDate } from './daily.js';

export const RECURRING_COLLECTION = 'recurring_shadow';
export const WINDOW_DAYS = 31;

const pick = (obj, keys) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

// 'YYYY-MM-DD' stays as-is; any other date/time becomes its Brisbane calendar day.
export function toDay(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : brisbaneDate(new Date(t));
}

// Money → integer cents (ex GST). null if not a number.
export function toCents(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function parseRun(r) {
  return {
    day: toDay(pick(r, ['day', 'date', 'invoiceDate', 'invoice_date', 'generatedAt', 'generated_at', 'createdAt', 'created_at'])),
    invoiceId: pick(r, ['invoiceId', 'invoice_id', 'id']) ?? null,
    number: pick(r, ['number', 'invoiceNumber', 'invoice_number']) ?? null,
    cents: toCents(pick(r, ['totalExGst', 'total_ex_gst', 'amountExGst', 'amount_ex_gst', 'subTotal', 'subtotal', 'amount'])),
  };
}

// Tolerant reader for DSOS's schedule list (exact shape is DSOS_REQUESTS #5).
// Accepts an array, or { data | schedules | items: [...] }.
export function parseSchedules(body) {
  const list = Array.isArray(body) ? body : (body?.data ?? body?.schedules ?? body?.items ?? []);
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s === 'object').map((s) => {
    const status = String(pick(s, ['status']) ?? '').toLowerCase();
    let active = pick(s, ['active', 'enabled']);
    if (typeof active !== 'boolean') active = !['paused', 'inactive', 'ended', 'cancelled', 'canceled', 'archived'].includes(status);
    const runs = (pick(s, ['recentRuns', 'recent_runs', 'runs', 'history', 'invoices']) ?? []);
    const parsedRuns = Array.isArray(runs) ? runs.map(parseRun).filter((r) => r.day) : [];
    // Fallback: a single "last generated" pair on the schedule itself.
    const lastDay = toDay(pick(s, ['lastGeneratedOn', 'last_generated_on', 'lastRunAt', 'last_run_at', 'lastGeneratedAt', 'last_generated_at']));
    if (lastDay && !parsedRuns.some((r) => r.day === lastDay)) {
      parsedRuns.push({ day: lastDay, invoiceId: pick(s, ['lastInvoiceId', 'last_invoice_id']) ?? null, number: null,
        cents: toCents(pick(s, ['lastAmountExGst', 'last_amount_ex_gst', 'lastTotalExGst'])) });
    }
    return {
      id: String(pick(s, ['id', 'scheduleId', 'schedule_id']) ?? ''),
      description: String(pick(s, ['description', 'name', 'title']) ?? '').slice(0, 120),
      active,
      nextRunOn: toDay(pick(s, ['nextRunOn', 'next_run_on', 'nextRunDate', 'next_run_date', 'nextDueOn', 'next_due_on', 'nextRunAt', 'next_run_at'])),
      cents: toCents(pick(s, ['amountExGst', 'amount_ex_gst', 'totalExGst', 'total_ex_gst', 'subTotal', 'subtotal', 'amount'])),
      runs: parsedRuns,
    };
  }).filter((s) => s.id);
}

// Which active schedules DSOS itself says will run on `day`.
export function predictDay(schedules, day) {
  return schedules
    .filter((s) => s.active && s.nextRunOn === day)
    .map((s) => ({ scheduleId: s.id, description: s.description, cents: s.cents }));
}

// Compare a day's prediction with what DSOS generated that day. Per schedule:
//   match           predicted, generated, amount equal (or either amount unknown)
//   amount-differs  predicted and generated, different amount
//   dsos-missed     predicted, not generated
//   unexpected      generated, not predicted
// Day verdict: 'mismatch' if any of the last three, else 'match' if anything generated, else 'quiet'.
export function verifyDay(predicted, schedules, day) {
  const byId = new Map(schedules.map((s) => [s.id, s]));
  const items = [];
  const seen = new Set();
  for (const p of predicted) {
    seen.add(p.scheduleId);
    const run = byId.get(p.scheduleId)?.runs.find((r) => r.day === day);
    let verdict = 'dsos-missed';
    if (run) verdict = p.cents !== null && run.cents !== null && p.cents !== run.cents ? 'amount-differs' : 'match';
    items.push({ ...p, generated: Boolean(run), invoiceId: run?.invoiceId ?? null, number: run?.number ?? null, generatedCents: run?.cents ?? null, verdict });
  }
  for (const s of schedules) {
    if (seen.has(s.id)) continue;
    const run = s.runs.find((r) => r.day === day);
    if (run) items.push({ scheduleId: s.id, description: s.description, cents: null, generated: true, invoiceId: run.invoiceId, number: run.number, generatedCents: run.cents, verdict: 'unexpected' });
  }
  const bad = items.some((i) => i.verdict !== 'match');
  return { items, verdict: bad ? 'mismatch' : items.length ? 'match' : 'quiet' };
}

// One row per target day: { day, predictedAt, predicted, verifiedAt?, items?, verdict? }
function rowFor(store, day) {
  return store.list(RECURRING_COLLECTION, (e) => e.day === day).at(-1);
}

export function savePrediction(store, { day, predicted, now, runId }) {
  const row = rowFor(store, day);
  const data = { day, predictedAt: now.toISOString(), predicted, predictRunId: runId };
  const out = row ? store.update(RECURRING_COLLECTION, row.id, data) : store.insert(RECURRING_COLLECTION, data);
  store.trim(RECURRING_COLLECTION, 400);
  return out;
}

// Verify `day` against the stored prediction. No prediction = DS Flow wasn't running the
// evening before: recorded as 'flow-missed' (still lists what DSOS generated, for the record).
export function saveVerification(store, { day, schedules, now, runId }) {
  const row = rowFor(store, day);
  const result = row?.predicted
    ? verifyDay(row.predicted, schedules, day)
    : { ...verifyDay([], schedules, day), verdict: 'flow-missed' };
  const data = { day, verifiedAt: now.toISOString(), verifyRunId: runId, ...result };
  const out = row ? store.update(RECURRING_COLLECTION, row.id, data) : store.insert(RECURRING_COLLECTION, data);
  store.trim(RECURRING_COLLECTION, 400);
  return out;
}

// Window of `days` checked days ending `endDay` (yesterday). Unchecked day = 'flow-missed'.
export function windowReport(entries, endDay, days = WINDOW_DAYS) {
  const byDay = new Map(entries.map((e) => [e.day, e]));
  const end = new Date(`${endDay}T00:00:00Z`);
  const list = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const e = byDay.get(d);
    list.push({ day: d, verdict: e?.verdict ?? 'flow-missed', invoices: e?.items?.filter((x) => x.generated).length ?? 0 });
  }
  const clean = list.filter((d) => d.verdict === 'match' || d.verdict === 'quiet').length;
  const matchedInvoices = entries
    .filter((e) => list.some((d) => d.day === e.day))
    .reduce((n, e) => n + (e.items?.filter((i) => i.verdict === 'match').length ?? 0), 0);
  const mismatchDays = list.filter((d) => d.verdict === 'mismatch').map((d) => d.day);
  const ready = clean === days && matchedInvoices > 0;
  return {
    from: list[0].day,
    to: endDay,
    days: list,
    cleanDays: clean,
    matchedInvoices,
    mismatchDays,
    readyToSwitch: ready,
    headline: ready
      ? `Recurring invoices: ${days}/${days} days clean, ${matchedInvoices} matched, ready to switch`
      : `Recurring invoices shadow: ${clean}/${days} days clean, ${matchedInvoices} matched` +
        (mismatchDays.length ? `, ${mismatchDays.length} mismatch` : ''),
  };
}

export function recurringReport(store, now) {
  const entries = store.list(RECURRING_COLLECTION);
  const today = brisbaneDate(now);
  const report = windowReport(entries.filter((e) => e.verdict), brisbaneDate(now, -1));
  const upcoming = entries.filter((e) => e.day >= today && !e.verdict).map((e) => ({ day: e.day, predicted: e.predicted }));
  const recentMismatches = entries.filter((e) => e.verdict === 'mismatch').slice(-10).reverse();
  return { ...report, upcoming, recentMismatches };
}
