// Daily Xero back-feed, shadow week.
//
// DSOS already runs its own morning Xero back-feed (payments, edits, credit notes, bill status).
// DS Flow's job is to take over the *scheduling* of it (and alert when it fails), not to talk
// to Xero itself: Xero credentials stay in DSOS. Before switching, DS Flow runs alongside for
// a week: each morning it reads DSOS's sync status, logs the sync request it *would* send
// (shadow), and records whether DSOS's own run happened. Seven matching days in a row = ready.
import { brisbaneDate } from './daily.js';

export const BACKFEED_COLLECTION = 'backfeed_shadow';
export const WEEK_DAYS = 7;

const pick = (obj, keys) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};

// Tolerant reader for DSOS's sync-status reply (exact shape is DSOS_REQUESTS #4).
// Accepts { lastRunAt, ok, error } plus common variants, optionally wrapped in { data } / { xero }.
export function parseSyncStatus(body) {
  const b = body?.data ?? body?.xero ?? body ?? {};
  const raw = pick(b, ['lastRunAt', 'last_run_at', 'lastSyncAt', 'last_sync_at', 'lastSyncedAt', 'last_synced_at', 'finishedAt', 'finished_at']);
  const t = raw === undefined ? NaN : Date.parse(raw);
  let ok = pick(b, ['ok', 'success']);
  if (ok === undefined) {
    const s = String(pick(b, ['status', 'lastStatus', 'last_status']) ?? '').toLowerCase();
    if (['ok', 'success', 'succeeded', 'complete', 'completed', 'green'].includes(s)) ok = true;
    else if (['failed', 'error', 'red'].includes(s)) ok = false;
  }
  const error = pick(b, ['error', 'lastError', 'last_error']);
  return {
    lastRunAt: Number.isNaN(t) ? null : new Date(t).toISOString(),
    ok: typeof ok === 'boolean' ? ok : null,
    error: error ? String(error).slice(0, 300) : null,
  };
}

// One day's comparison. verdict:
//   match        DSOS's own sync ran today (Brisbane) and was OK, and DS Flow was there to see it
//   dsos-failed  DSOS ran today but reported a failure
//   dsos-missed  DSOS's last run is not from today
//   no-data      DSOS's status gave no usable run time
export function compareDay({ now, status }) {
  const day = brisbaneDate(now);
  const ranToday = status.lastRunAt ? brisbaneDate(new Date(status.lastRunAt)) === day : false;
  let verdict;
  if (!status.lastRunAt) verdict = 'no-data';
  else if (!ranToday) verdict = 'dsos-missed';
  else if (status.ok === false) verdict = 'dsos-failed';
  else verdict = 'match';
  return {
    day,
    checkedAt: now.toISOString(),
    dsosLastRunAt: status.lastRunAt,
    dsosOk: status.ok,
    dsosError: status.error,
    dsosRanToday: ranToday,
    verdict,
  };
}

// Last `days` Brisbane days ending `endDay` (inclusive). A day with no entry = 'flow-missed'
// (DS Flow itself didn't run), which also breaks the streak.
export function weekReport(entries, endDay, days = WEEK_DAYS) {
  const byDay = new Map(entries.map((e) => [e.day, e]));
  const end = new Date(`${endDay}T00:00:00Z`);
  const list = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    list.push({ day: d, verdict: byDay.get(d)?.verdict ?? 'flow-missed' });
  }
  const matched = list.filter((d) => d.verdict === 'match').length;
  let streak = 0;
  for (let i = list.length - 1; i >= 0 && list[i].verdict === 'match'; i--) streak++;
  return {
    from: list[0].day,
    to: endDay,
    days: list,
    matched,
    streak,
    readyToSwitch: matched === days,
    headline: matched === days
      ? `Xero back-feed: ${days}/${days} days matched, ready to switch`
      : `Xero back-feed shadow: ${matched}/${days} days matched`,
  };
}

// Store one entry per Brisbane day (a re-run the same day replaces it).
export function recordDay(store, entry) {
  const existing = store.list(BACKFEED_COLLECTION, (e) => e.day === entry.day).at(-1);
  const row = existing ? store.update(BACKFEED_COLLECTION, existing.id, entry) : store.insert(BACKFEED_COLLECTION, entry);
  store.trim(BACKFEED_COLLECTION, 400);
  return row;
}

export function backfeedReport(store, now) {
  const entries = store.list(BACKFEED_COLLECTION);
  return { ...weekReport(entries, brisbaneDate(now)), recent: entries.slice(-WEEK_DAYS).reverse() };
}
